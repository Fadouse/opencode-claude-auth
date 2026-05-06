import type { Plugin } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
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
  transformBody,
  transformResponseStream,
  type TransformIdentitySeed,
} from "./transforms.ts"
import {
  applyOpencodeConfig,
  getApiKeyProviderID,
  getPluginSettings,
  loadPluginSettingsFromFile,
} from "./plugin-config.ts"
import {
  getCachedCredentials,
  getCredentialsForSync,
  syncApiKeyAuthJson,
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
export {
  isEnable1mContext,
  isEnable1hCacheTTL,
  type PluginSettings,
} from "./plugin-config.ts"
export {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./signing.ts"

const SYSTEM_IDENTITY_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude."
const OFFICIAL_PROVIDER_ID = "anthropic"
const API_KEY_PROVIDER_DISABLED = "__opencode_claude_auth_api_key_disabled__"
const API_KEY_PROVIDER_NPM = "@ai-sdk/anthropic"
const apiKeyIdentitySeed: TransformIdentitySeed = {
  deviceId: crypto.randomUUID(),
  accountUuid: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
}
const SUPPORTED_CLAUDE_MODELS = [
  "claude-3-haiku-20240307",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
] as const
await loadPluginSettingsFromFile()

function resolveApiKeyProviderID(): string {
  return getApiKeyProviderID() ?? API_KEY_PROVIDER_DISABLED
}

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, cli)`
  )
}

function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = crypto.randomUUID()

type FetchFn = typeof fetch
interface BuildRequestHeaderOptions {
  preserveApiKey?: boolean
}

const OFFICIAL_HEADER_DEFAULTS = {
  "anthropic-dangerous-direct-browser-access": "true",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Linux",
  "x-stainless-package-version": "0.81.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v24.3.0",
  "x-stainless-timeout": "600",
} as const

// Maximum delay before we give up retrying and surface the error.
// A retry-after longer than this signals a quota/usage-limit reset (hours away)
// rather than a transient rate limit — retrying would hang indefinitely.
// Override with OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS for longer retry windows.
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

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
      // If delay exceeds the cap, the server is signalling a quota/usage-limit
      // reset far in the future. Return immediately so the error surfaces to
      // the user rather than silently hanging until the reset time.
      if (delay > getMaxRetryDelayMs()) {
        log("fetch_rate_limited_quota", {
          status: res.status,
          retryAfter: retryAfter ?? "none",
          delayMs: delay,
        })
        return res
      }
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay,
      })
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
  requestSessionId?: string,
  options?: BuildRequestHeaderOptions,
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

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("X-Claude-Code-Session-Id", requestSessionId ?? sessionId)
  for (const [key, value] of Object.entries(OFFICIAL_HEADER_DEFAULTS)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  if (!options?.preserveApiKey) {
    headers.delete("x-api-key")
  }

  return headers
}

function getRequestModelId(init?: RequestInit): string {
  const bodyStr = typeof init?.body === "string" ? init.body : undefined
  if (!bodyStr) return "unknown"

  try {
    return (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown"
  } catch {
    return "unknown"
  }
}

function rewriteSmallModelForTitleRequest(
  init: RequestInit,
  smallModel: string | undefined,
): RequestInit {
  if (!smallModel || typeof init.body !== "string") {
    return init
  }

  try {
    const parsed = JSON.parse(init.body) as {
      model?: string
      system?: Array<{ text?: string; type?: string }>
    }
    const systemText = (parsed.system ?? [])
      .map((entry) => entry.text ?? "")
      .join("\n")
    if (!systemText.includes("You are a title generator.")) {
      return init
    }

    return {
      ...init,
      body: JSON.stringify({
        ...parsed,
        model: smallModel,
      }),
    }
  } catch {
    return init
  }
}

function injectSystemIdentity(
  providerID: string | undefined,
  output: { system: string[] },
  expectedProviderID: string,
): void {
  if (providerID !== expectedProviderID) {
    return
  }

  const hasIdentityPrefix = output.system.some((entry) =>
    entry.includes(SYSTEM_IDENTITY_PREFIX),
  )
  if (!hasIdentityPrefix) {
    output.system.unshift(SYSTEM_IDENTITY_PREFIX)
  }
}

function zeroModelCosts(provider: {
  models: Record<string, { cost?: unknown }>
}) {
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    }
  }
}

function logResponseWarnings(response: Response, modelId: string): void {
  if (response.ok) {
    return
  }

  const status = response.status
  const cloned = response.clone()
  cloned
    .text()
    .then((errorBody) => {
      let message = errorBody
      try {
        const parsed = JSON.parse(errorBody) as {
          error?: { type?: string; message?: string }
        }
        message = parsed.error?.message ?? parsed.error?.type ?? errorBody
      } catch {}
      log("fetch_error_response", { status, modelId, message })
      console.warn(
        `opencode-claude-auth: API ${status} for ${modelId}: ${message}`,
      )
    })
    .catch(() => {})
}

function buildClaudeModelConfig(): Record<string, { name: string }> {
  return Object.fromEntries(
    SUPPORTED_CLAUDE_MODELS.map((modelId) => {
      const supportsReasoning = !modelId.includes("haiku")
      return [
        modelId,
        {
          name: modelId,
          reasoning: supportsReasoning,
          ...(supportsReasoning
            ? {
                variants: {
                  low: { effort: "low" },
                  medium: { effort: "medium" },
                  high: { effort: "high" },
                  max: { effort: "max" },
                },
              }
            : {}),
        },
      ]
    }),
  )
}

function stableHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function buildOAuthIdentitySeed(
  creds: ClaudeCredentials,
): TransformIdentitySeed {
  return {
    deviceId: creds.userID ?? stableHex(`device:${creds.accessToken}`),
    accountUuid:
      creds.accountUuid ??
      stableHex(`account:${creds.refreshToken}`).replace(
        /^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/,
        "$1-$2-$3-$4-$5",
      ),
    sessionId: sessionId,
  }
}

function syncApiKeyAuthIfPossible(): void {
  const configured = getPluginSettings().apiKeyProvider
  if (!configured) {
    return
  }

  try {
    syncApiKeyAuthJson(configured.id, configured.apiKey)
  } catch (error) {
    log("sync_auth_json", {
      providerId: configured.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function ensureApiKeyProviderConfig(opencodeConfig: unknown): void {
  const apiKeyProvider = getPluginSettings().apiKeyProvider
  if (
    !apiKeyProvider ||
    !opencodeConfig ||
    typeof opencodeConfig !== "object"
  ) {
    return
  }

  const configRecord = opencodeConfig as Record<string, unknown>
  if (!configRecord.provider || typeof configRecord.provider !== "object") {
    configRecord.provider = {}
  }

  const providerConfig = configRecord.provider as Record<string, unknown>
  const existing =
    providerConfig[apiKeyProvider.id] &&
    typeof providerConfig[apiKeyProvider.id] === "object"
      ? (providerConfig[apiKeyProvider.id] as Record<string, unknown>)
      : {}

  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? (existing.options as Record<string, unknown>)
      : {}

  providerConfig[apiKeyProvider.id] = {
    ...existing,
    id: apiKeyProvider.id,
    name: typeof existing.name === "string" ? existing.name : apiKeyProvider.id,
    npm: typeof existing.npm === "string" ? existing.npm : API_KEY_PROVIDER_NPM,
    options: {
      ...existingOptions,
      baseURL: apiKeyProvider.baseURL,
    },
    models:
      existing.models && typeof existing.models === "object"
        ? existing.models
        : buildClaudeModelConfig(),
  }

  const selectedModel =
    typeof configRecord.model === "string" ? configRecord.model : undefined
  if (
    apiKeyProvider.smallModel &&
    selectedModel?.startsWith(`${apiKeyProvider.id}/`)
  ) {
    configRecord.small_model = `${apiKeyProvider.id}/${apiKeyProvider.smallModel}`
  }
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

export const ClaudeAuthPlugin: Plugin = async () => {
  initLogger()
  await loadPluginSettingsFromFile()

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

  initAccounts(accounts)

  const defaultAccountSource = accounts[0]?.source ?? null

  if (accounts.length > 0) {
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
        "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
      )
    }

    // Keep auth.json synced with current credentials (no refresh triggered)
    const syncTimer = setInterval(() => {
      try {
        const creds = getCredentialsForSync()
        if (creds) syncAuthJson(creds)
      } catch {
        // Non-fatal
      }
    }, SYNC_INTERVAL)
    syncTimer.unref()
  } else {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hook enabled.",
    )
  }

  return {
    config: async (opencodeConfig) => {
      applyOpencodeConfig(opencodeConfig)
      ensureApiKeyProviderConfig(opencodeConfig)
    },
    "experimental.chat.system.transform": async (input, output) => {
      injectSystemIdentity(
        input.model?.providerID,
        output,
        OFFICIAL_PROVIDER_ID,
      )
    },
    auth: {
      provider: OFFICIAL_PROVIDER_ID,
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

        zeroModelCosts(provider)

        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length,
        })

        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const latest = getCachedCredentials()
            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

            const requestInit = init ?? {}
            const modelId = getRequestModelId(requestInit)

            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt,
            })

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const body = transformBody(requestInit.body, {
              identitySeed: buildOAuthIdentitySeed(latest),
            })
            const transformedInit = {
              ...requestInit,
              body,
            }
            const requestUrl = buildRequestUrl(input)
            const headers = buildRequestHeaders(
              input,
              transformedInit,
              latest.accessToken,
              modelId,
              excluded,
            )

            const headerKeys: string[] = []
            headers.forEach((_, key) => headerKeys.push(key))
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            let response = await fetchWithRetry(requestUrl, {
              ...transformedInit,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // On 401, force a credential refresh and retry once.
            // This handles the common case of token expiry mid-session.
            if (response.status === 401) {
              log("fetch_401_retry", { modelId })
              const refreshed = getCachedCredentials()
              if (refreshed && refreshed.accessToken !== latest.accessToken) {
                const retryHeaders = buildRequestHeaders(
                  input,
                  transformedInit,
                  refreshed.accessToken,
                  modelId,
                  excluded,
                )
                response = await fetchWithRetry(requestUrl, {
                  ...transformedInit,
                  headers: retryHeaders,
                })
                log("fetch_401_retry_result", {
                  status: response.status,
                  modelId,
                })
              }
            }

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
              const currentCreds = getCachedCredentials()
              const retryToken = currentCreds?.accessToken ?? latest.accessToken
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                transformedInit,
                retryToken,
                modelId,
                newExcluded,
              )

              response = await fetchWithRetry(requestUrl, {
                ...transformedInit,
                headers: newHeaders,
              })
            }

            logResponseWarnings(response, modelId)

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
              loadPersistedAccountSource() ?? defaultAccountSource
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

export const ApiKeyProviderPlugin: Plugin = async () => {
  initLogger()
  syncApiKeyAuthIfPossible()

  return {
    config: async (opencodeConfig) => {
      applyOpencodeConfig(opencodeConfig)
      ensureApiKeyProviderConfig(opencodeConfig)
      syncApiKeyAuthIfPossible()
    },
    "experimental.chat.system.transform": async (input, output) => {
      injectSystemIdentity(
        input.model?.providerID,
        output,
        resolveApiKeyProviderID(),
      )
    },
    auth: {
      provider: resolveApiKeyProviderID(),
      async loader(getAuth, provider) {
        const apiKeyProvider = getPluginSettings().apiKeyProvider
        if (!apiKeyProvider) {
          return {}
        }

        await getAuth()
        zeroModelCosts(provider)

        return {
          apiKey: apiKeyProvider.apiKey,
          baseURL: apiKeyProvider.baseURL,
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const requestInit = rewriteSmallModelForTitleRequest(
              init ?? {},
              apiKeyProvider.smallModel,
            )
            const modelId = getRequestModelId(requestInit)
            const excluded = getExcludedBetas(modelId)
            const body = transformBody(requestInit.body, {
              anonymizeIdentity: true,
              identitySeed: apiKeyIdentitySeed,
            })
            const transformedInit = {
              ...requestInit,
              body,
            }
            const headers = buildRequestHeaders(
              input,
              transformedInit,
              apiKeyProvider.apiKey,
              modelId,
              excluded,
              apiKeyIdentitySeed.sessionId,
              { preserveApiKey: true },
            )

            let response = await fetchWithRetry(input, {
              ...transformedInit,
              body,
              headers,
            })

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
                break
              }

              addExcludedBeta(modelId, betaToExclude)
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                transformedInit,
                apiKeyProvider.apiKey,
                modelId,
                newExcluded,
                apiKeyIdentitySeed.sessionId,
                { preserveApiKey: true },
              )

              response = await fetchWithRetry(input, {
                ...transformedInit,
                body,
                headers: newHeaders,
              })
            }

            logResponseWarnings(response, modelId)
            return transformResponseStream(response)
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "Use configured API key",
          async authorize() {
            const apiKeyProvider = getPluginSettings().apiKeyProvider
            if (!apiKeyProvider) {
              return { type: "failed" as const }
            }

            return {
              type: "success" as const,
              key: apiKeyProvider.apiKey,
              provider: apiKeyProvider.id,
            }
          },
        },
      ],
    },
  }
}

export default ClaudeAuthPlugin
