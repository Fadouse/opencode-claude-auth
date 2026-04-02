import type { Plugin } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { config, EFFORT_BETA, supportsEffort } from "./model-config.ts"
import {
  readAllClaudeAccounts,
  readClaudeStateIdentity,
  type ClaudeAccount,
} from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  markToolsSentToAPIState,
  recordLastApiCompletionTimestamp,
  transformBody,
  transformResponseStream,
  type TransformContext,
} from "./transforms.ts"
import { getWorkload } from "./workload.ts"
import {
  getCachedCredentials,
  syncAuthJson,
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
  saveAccountSource,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
export { resetExcludedBetas } from "./betas.ts"
export {
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"

const DEFAULT_SYSTEM_IDENTITY_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude."
const OFFICIAL_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"
const ANTHROPIC_VERSION = "2023-06-01"
const REQUEST_TIMEOUT_SECONDS = "600"
const STAINLESS_LANGUAGE = "js"
const STAINLESS_OS_NAMES: Record<NodeJS.Platform, string> = {
  aix: "AIX",
  android: "Android",
  darwin: "MacOS",
  freebsd: "FreeBSD",
  haiku: "Haiku",
  linux: "Linux",
  openbsd: "OpenBSD",
  sunos: "SunOS",
  win32: "Windows",
  cygwin: "Windows",
  netbsd: "NetBSD",
}
const STAINLESS_PACKAGE_VERSION = "0.74.0"

function getCliVersion(): string {
  return config.ccVersion
}

function getUserAgent(): string {
  const userType = process.env.USER_TYPE ?? "external"
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ""

  return `claude-cli/${getCliVersion()} (${userType}, ${entrypoint}${workloadSuffix})`
}

function getStainlessOs(): string {
  return STAINLESS_OS_NAMES[process.platform] ?? process.platform
}

function buildClientRequestId(): string {
  return randomUUID()
}

function shouldSendClientRequestId(): boolean {
  return process.env.ANTHROPIC_API_PROVIDER === "firstParty"
}

function filterModelCapabilityBetas(
  modelId: string,
  betas: string[],
): string[] {
  if (supportsEffort(modelId)) {
    return betas
  }

  return betas.filter((beta) => beta !== EFFORT_BETA)
}

function normalizeAnthropicMessagesInput(
  input: RequestInfo | URL,
): RequestInfo | URL {
  let url: URL

  try {
    if (input instanceof Request) {
      url = new URL(input.url)
    } else if (input instanceof URL) {
      url = new URL(input.toString())
    } else {
      url = new URL(input)
    }
  } catch {
    return input
  }

  if (
    url.origin !== "https://api.anthropic.com" ||
    url.pathname !== "/v1/messages"
  ) {
    return input
  }

  const normalizedUrl = OFFICIAL_MESSAGES_URL

  if (input instanceof Request) {
    return new Request(normalizedUrl, input)
  }

  if (input instanceof URL) {
    return new URL(normalizedUrl)
  }

  return normalizedUrl
}

function buildTransformContext(
  credentials: ClaudeCredentials,
  sessionId: string,
): TransformContext {
  const stateIdentity = readClaudeStateIdentity()
  const deviceId = stateIdentity?.userID ?? credentials.userID

  if (!deviceId) {
    throw new Error(
      "Claude Code official device_id is unavailable. Run `claude` once so ~/.claude/.claude.json can be initialized.",
    )
  }

  return {
    accountUuid: stateIdentity?.accountUuid ?? credentials.accountUuid,
    cliVersion: getCliVersion(),
    deviceId,
    sessionId,
  }
}

type FetchFn = typeof fetch

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
  requestContext?: { clientRequestId?: string; sessionId?: string },
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  }

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ]
  const capabilityFilteredBetas = filterModelCapabilityBetas(
    modelId,
    mergedBetas,
  )

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("accept", "application/json")
  headers.set("anthropic-beta", capabilityFilteredBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("anthropic-version", ANTHROPIC_VERSION)
  headers.set("content-type", "application/json")
  headers.set("x-app", "cli")
  headers.set(
    "x-claude-code-session-id",
    requestContext?.sessionId ?? randomUUID(),
  )
  if (shouldSendClientRequestId()) {
    headers.set(
      "x-client-request-id",
      requestContext?.clientRequestId ?? buildClientRequestId(),
    )
  } else {
    headers.delete("x-client-request-id")
  }
  headers.set("x-stainless-arch", process.arch)
  headers.set("x-stainless-lang", STAINLESS_LANGUAGE)
  headers.set("x-stainless-os", getStainlessOs())
  headers.set("x-stainless-package-version", STAINLESS_PACKAGE_VERSION)
  headers.set("x-stainless-retry-count", "0")
  headers.set("x-stainless-runtime", "node")
  headers.set("x-stainless-runtime-version", process.version)
  headers.set("x-stainless-timeout", REQUEST_TIMEOUT_SECONDS)
  headers.set("user-agent", getUserAgent())
  headers.delete("x-api-key")

  return headers
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

const plugin: Plugin = async () => {
  initLogger()
  process.env.CLAUDE_CODE_ENTRYPOINT ??= "cli"
  process.env.USER_TYPE ??= "external"
  const sessionId = randomUUID()

  let accounts: ClaudeAccount[] = []
  try {
    accounts = readAllClaudeAccounts()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log("plugin_init_error", { error })
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      error,
    )
    return {}
  }

  if (accounts.length === 0) {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. " +
        "Plugin disabled. Run `claude` to authenticate.",
    )
    return {}
  }

  initAccounts(accounts)

  const persistedSource = loadPersistedAccountSource()
  const defaultAccount =
    (persistedSource && accounts.find((a) => a.source === persistedSource)) ||
    accounts[0]

  setActiveAccountSource(defaultAccount.source)

  log("plugin_init", {
    accountCount: accounts.length,
    sources: accounts.map((a) => a.source),
    activeSource: defaultAccount.source,
  })

  const initialCreds = getCachedCredentials()
  if (initialCreds) {
    syncAuthJson(initialCreds)
  } else {
    console.warn(
      "opencode-claude-auth: Claude credentials are expired and could not be refreshed via Claude CLI.",
    )
  }

  // Keep auth.json synced, refreshing via CLI if token is near expiry
  const syncTimer = setInterval(() => {
    try {
      const fresh = getCachedCredentials()
      if (fresh) syncAuthJson(fresh)
    } catch {
      // Non-fatal
    }
  }, SYNC_INTERVAL)
  syncTimer.unref()

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) =>
        entry.includes(DEFAULT_SYSTEM_IDENTITY_PREFIX),
      )
      if (!hasIdentityPrefix) {
        output.system.unshift(DEFAULT_SYSTEM_IDENTITY_PREFIX)
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        log("auth_loader_called", { authType: auth.type })
        if (auth.type !== "oauth") {
          log("auth_loader_skipped", {
            authType: auth.type,
            reason: "auth type is not oauth",
          })
          return {}
        }

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length,
        })

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const normalizedInput = normalizeAnthropicMessagesInput(input)
            const latest = getCachedCredentials()
            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

            const requestInit = init ?? {}
            const bodyStr =
              typeof requestInit.body === "string"
                ? requestInit.body
                : undefined
            let modelId = "unknown"
            if (bodyStr) {
              try {
                modelId =
                  (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown"
              } catch {}
            }

            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt,
            })

            const clientRequestId = buildClientRequestId()

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const headers = buildRequestHeaders(
              normalizedInput,
              requestInit,
              latest.accessToken,
              modelId,
              excluded,
              { clientRequestId, sessionId },
            )
            const body = transformBody(
              requestInit.body,
              buildTransformContext(latest, sessionId),
            )

            const headerKeys: string[] = []
            headers.forEach((_, key) => headerKeys.push(key))
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            let response = await fetchWithRetry(normalizedInput, {
              ...requestInit,
              body,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // Check for long-context beta errors and retry with betas excluded
            // Try up to LONG_CONTEXT_BETAS.length times, excluding one more beta each time
            for (
              let attempt = 0;
              attempt < LONG_CONTEXT_BETAS.length;
              attempt++
            ) {
              if (response.status !== 400 && response.status !== 429) {
                break
              }

              const cloned = response.clone()
              const responseBody = await cloned.text()

              if (!isLongContextError(responseBody)) {
                break
              }

              const betaToExclude = getNextBetaToExclude(modelId)
              if (!betaToExclude) {
                break // All long-context betas already excluded
              }

              addExcludedBeta(modelId, betaToExclude)
              log("fetch_beta_excluded", {
                modelId,
                excludedBeta: betaToExclude,
              })

              // Rebuild headers without the excluded beta and retry
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                normalizedInput,
                requestInit,
                latest.accessToken,
                modelId,
                newExcluded,
                { clientRequestId, sessionId },
              )

              response = await fetchWithRetry(normalizedInput, {
                ...requestInit,
                body,
                headers: newHeaders,
              })
            }

            // Official source citation:
            // - `.inspect-claude-code-2.1.88/src/services/compact/microCompact.ts:124-127`
            //   defines `markToolsSentToAPIState()`.
            // - `.inspect-claude-code-2.1.88/src/services/api/claude.ts:2833-2836`
            //   calls it after the successful API response flow.
            if (response.ok) {
              markToolsSentToAPIState()
              recordLastApiCompletionTimestamp()
            }

            return transformResponseStream(response)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Switch Claude Code account",

          get prompts() {
            const currentAccounts = refreshAccountsList()
            const currentSource =
              loadPersistedAccountSource() ?? defaultAccount.source
            if (currentAccounts.length <= 1) return []
            return [
              {
                type: "select" as const,
                key: "account",
                message: "Select which Claude Code account to use:",
                options: currentAccounts.map((a) => ({
                  label: a.label,
                  value: a.source,
                  hint:
                    a.source === currentSource
                      ? `${a.source} (active)`
                      : a.source,
                })),
              },
            ]
          },

          async authorize(inputs) {
            const latestAccounts = refreshAccountsList()

            const source =
              inputs?.account ?? latestAccounts[0]?.source ?? accounts[0].source
            const chosen =
              latestAccounts.find((a) => a.source === source) ??
              accounts.find((a) => a.source === source) ??
              latestAccounts[0] ??
              accounts[0]

            setActiveAccountSource(chosen.source)
            const creds = getCachedCredentials() ?? chosen.credentials

            syncAuthJson(creds)
            saveAccountSource(chosen.source)

            const sourceDescription =
              chosen.source === "file"
                ? "credentials file (~/.claude/.credentials.json)"
                : "macOS Keychain"

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${sourceDescription}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt,
                }
              },
            }
          },
        },
      ],
    },
  }
}

export const ClaudeAuthPlugin = plugin
export default plugin
