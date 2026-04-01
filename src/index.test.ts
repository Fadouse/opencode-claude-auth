import assert from "node:assert/strict"
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { before, describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { config as modelConfig } from "./model-config.ts"

interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountUuid?: string
  userID?: string
}

type TestAuthLoader = (
  getAuth: () => Promise<{
    type: "oauth"
    refresh: string
    access: string
    expires: number
  }>,
  provider: { models: Record<string, { cost?: unknown }> },
) => Promise<{
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}>

interface Account {
  label: string
  source: string
  credentials: ClaudeCredentials
}

function getRequestUrl(
  input: RequestInfo | URL | undefined,
): string | undefined {
  if (!input) {
    return undefined
  }

  if (input instanceof Request) {
    return input.url
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input
}

function getExpectedStainlessOs(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "MacOS"
    case "win32":
    case "cygwin":
      return "Windows"
    case "linux":
      return "Linux"
    case "haiku":
      return "Haiku"
    default:
      return platform
  }
}

// Mirrors authorize()'s account-resolution logic
function resolveAccount(
  accounts: Account[],
  selectedSource: string | undefined,
): Account {
  const found = accounts.find((a) => a.source === selectedSource)
  return found ?? accounts[0]
}

// Mirrors the select prompt options builder
function buildSelectOptions(
  accounts: Account[],
  activeSource: string,
): Array<{ label: string; value: string; hint: string }> {
  return accounts.map((a) => ({
    label: a.label,
    value: a.source,
    hint: a.source === activeSource ? `${a.source} (active)` : a.source,
  }))
}

// Mirrors syncToPath logic
function syncToPath(
  authPath: string,
  creds: ClaudeCredentials,
  fs: {
    existsSync: (p: string) => boolean
    readFileSync: (p: string, enc: string) => string
    writeFileSync: (p: string, data: string, enc: string) => void
    mkdirSync: (p: string, opts: object) => void
    dirname: (p: string) => string
  },
): void {
  let auth: Record<string, unknown> = {}
  if (fs.existsSync(authPath)) {
    const raw = fs.readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = fs.dirname(authPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8")
}

// Mirrors refreshIfNeeded expiry logic
function refreshIfNeeded(
  creds: ClaudeCredentials,
  nowMs: number,
): "fresh" | "expired" {
  return creds.expiresAt > nowMs + 60_000 ? "fresh" : "expired"
}

// Mirrors the authorize() callback return shape
function buildAuthorizeResult(account: Account) {
  const creds = account.credentials
  return {
    url: "",
    instructions: `Using ${account.label} — credentials loaded from macOS Keychain.`,
    method: "auto" as const,
    async callback() {
      return {
        type: "success" as const,
        provider: "anthropic",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      }
    },
  }
}

const SOURCE_FILES = [
  "index.ts",
  "betas.ts",
  "model-config.ts",
  "transforms.ts",
  "workload.ts",
  "credentials.ts",
  "logger.ts",
] as const

async function copySourceFiles(tempDir: string): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      source = source.replace(
        /from\s+["']\.\/([\w-]+)\.js["']/g,
        'from "./$1.ts"',
      )
      await writeFile(join(tempDir, file), source, "utf8")
    }),
  )
}

async function loadHelpersWithCountingKeychain(
  initialExpiresAt: number,
  credentialOverrides: Partial<ClaudeCredentials> = {},
  stateIdentity: { accountUuid?: string; userID?: string } | null = {
    accountUuid: "acct-state-default",
    userID: "device-state-default",
  },
): Promise<{
  helpersModule: typeof import("./index.ts")
  keychainModule: { __getReadCount: () => number }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cache-"))
  const tempKeychain = join(tempDir, "keychain.ts")

  await copySourceFiles(tempDir)
  const credentialsLiteral = JSON.stringify(
    {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt: initialExpiresAt,
      ...credentialOverrides,
    },
    null,
    2,
  )
  const stateIdentityLiteral = JSON.stringify(stateIdentity, null, 2)
  await writeFile(
    tempKeychain,
    `let readCount = 0
let credentials = ${credentialsLiteral}
let stateIdentity = ${stateIdentityLiteral}

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "Claude Code-credentials", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function readClaudeStateIdentity() {
  return stateIdentity
}

export function buildAccountLabels(creds) {
  return creds.map((_, i) => \`Account \${i + 1}\`)
}

export function __getReadCount() {
  return readCount
}
`,
    "utf8",
  )

  const [helpersModule, keychainModule] = await Promise.all([
    import(pathToFileURL(join(tempDir, "index.ts")).href),
    import(pathToFileURL(tempKeychain).href),
  ])

  return {
    helpersModule,
    keychainModule: keychainModule as { __getReadCount: () => number },
  }
}

function makeCreds(overrides?: Partial<ClaudeCredentials>): ClaudeCredentials {
  return {
    accessToken: "sk-ant-test-access",
    refreshToken: "sk-ant-test-refresh",
    expiresAt: Date.now() + 300_000,
    ...overrides,
  }
}

const accounts: Account[] = [
  {
    label: "Account 1",
    source: "Claude Code-credentials",
    credentials: makeCreds({ accessToken: "at-1" }),
  },
  {
    label: "Account 2",
    source: "Claude Code-credentials-b28bbb7c",
    credentials: makeCreds({ accessToken: "at-2" }),
  },
  {
    label: "Account 3",
    source: "Claude Code-credentials-abc123",
    credentials: makeCreds({ accessToken: "at-3" }),
  },
]

const realFs = {
  existsSync: (p: string) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  },
  readFileSync: (p: string, _enc: string) => readFileSync(p, "utf-8"),
  writeFileSync: (p: string, data: string, _enc: string) =>
    writeFileSync(p, data, "utf-8"),
  mkdirSync: (p: string, opts: object) =>
    mkdirSync(p, opts as Parameters<typeof mkdirSync>[1]),
  dirname: (p: string) => dirname(p),
}

let helpers: typeof import("./index.ts")
let workloadHelpers: typeof import("./workload.ts")

describe("exported helpers", () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-"))
    const tempKeychain = join(tempDir, "keychain.ts")

    await copySourceFiles(tempDir)
    await writeFile(
      tempKeychain,
      `export function readAllClaudeAccounts() { return [{ label: "Account 1", source: "Claude Code-credentials", credentials: { accessToken: "token", refreshToken: "refresh", expiresAt: 1 } }] }
export function refreshAccount() { return null }
export function readClaudeStateIdentity() { return { accountUuid: "acct-state-default", userID: "device-state-default" } }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }
`,
      "utf8",
    )

    helpers = await import(pathToFileURL(join(tempDir, "index.ts")).href)
    workloadHelpers = await import(
      pathToFileURL(join(tempDir, "workload.ts")).href
    )
  })

  it("buildRequestHeaders sets auth headers and strips x-api-key", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages?beta=true",
      {
        headers: {
          "anthropic-beta": "custom-beta",
          "x-api-key": "old-key",
          "x-custom": "keep-me",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
      undefined,
      {
        clientRequestId: "request-123",
        sessionId: "session-123",
      },
    )

    assert.equal(headers.get("authorization"), "Bearer access-token")
    assert.equal(headers.get("accept"), "application/json")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("x-custom"), "keep-me")
    assert.ok(headers.get("anthropic-beta")?.includes("custom-beta"))
    assert.ok(
      headers.get("anthropic-beta")?.includes("redact-thinking-2026-02-12"),
    )
    assert.ok(
      headers.get("anthropic-beta")?.includes("advanced-tool-use-2025-11-20"),
    )
    assert.ok(headers.get("anthropic-beta")?.includes("effort-2025-11-24"))
    assert.equal(headers.get("x-anthropic-billing-header"), null)
    assert.equal(
      headers.get("anthropic-dangerous-direct-browser-access"),
      "true",
    )
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    assert.equal(headers.get("content-type"), "application/json")
    assert.equal(
      headers.get("user-agent"),
      `claude-cli/${modelConfig.ccVersion} (external, cli)`,
    )
    assert.equal(headers.get("x-app"), "cli")
    assert.equal(headers.get("x-claude-code-session-id"), "session-123")
    assert.equal(headers.get("x-client-request-id"), "request-123")
    assert.equal(headers.get("x-stainless-arch"), process.arch)
    assert.equal(headers.get("x-stainless-lang"), "js")
    assert.equal(
      headers.get("x-stainless-os"),
      getExpectedStainlessOs(process.platform),
    )
    assert.equal(headers.get("x-stainless-package-version"), "0.74.0")
    assert.equal(headers.get("x-stainless-retry-count"), "0")
    assert.equal(headers.get("x-stainless-runtime"), "node")
    assert.equal(headers.get("x-stainless-runtime-version"), process.version)
    assert.equal(headers.get("x-stainless-timeout"), "600")
  })

  it("buildRequestHeaders strips unsupported effort beta for haiku models", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages?beta=true",
      {
        headers: {
          "anthropic-beta":
            "effort-2025-11-24,structured-outputs-2025-12-15,custom-beta",
        },
      },
      "access-token",
      "claude-haiku-4-5-20251001",
      undefined,
      {
        clientRequestId: "request-123",
        sessionId: "session-123",
      },
    )

    assert.equal(
      headers.get("anthropic-beta")?.includes("effort-2025-11-24"),
      false,
    )
    assert.ok(
      headers.get("anthropic-beta")?.includes("structured-outputs-2025-12-15"),
    )
    assert.ok(headers.get("anthropic-beta")?.includes("custom-beta"))
  })

  it("buildRequestHeaders ignores ANTHROPIC_* user-agent overrides", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"
    try {
      const headers = helpers.buildRequestHeaders(
        "https://api.anthropic.com/v1/messages?beta=true",
        { headers: {} },
        "token",
        "claude-sonnet-4-6",
        undefined,
        {
          clientRequestId: "request-123",
          sessionId: "session-123",
        },
      )
      assert.equal(
        headers.get("user-agent"),
        `claude-cli/${modelConfig.ccVersion} (external, cli)`,
      )
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
      delete process.env.ANTHROPIC_USER_AGENT
    }
  })

  it("buildRequestHeaders appends workload suffix to user-agent when workload is set", () => {
    const originalUserType = process.env.USER_TYPE
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_CODE_ENTRYPOINT

    try {
      const headers = workloadHelpers.runWithWorkload("cron", () =>
        helpers.buildRequestHeaders(
          "https://api.anthropic.com/v1/messages?beta=true",
          { headers: {} },
          "token",
          "claude-sonnet-4-6",
          undefined,
          {
            clientRequestId: "request-123",
            sessionId: "session-123",
          },
        ),
      )

      assert.equal(
        headers.get("user-agent"),
        `claude-cli/${modelConfig.ccVersion} (external, cli, workload/cron)`,
      )
    } finally {
      if (typeof originalUserType === "string") {
        process.env.USER_TYPE = originalUserType
      } else {
        delete process.env.USER_TYPE
      }

      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
    }
  })

  it("fetchWithRetry retries on 429 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("rate limited", { status: 429 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry retries on 529 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("overloaded", { status: 529 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry returns non-retryable errors immediately", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 400)
    assert.equal(callCount, 1)
  })

  it("fetchWithRetry gives up after max retries", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("rate limited", { status: 429 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      2,
      mockFetch,
    )
    assert.equal(res.status, 429)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry respects retry-after header", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 900, `Expected at least 900ms delay, got ${elapsed}ms`)
  })

  it("fetchWithRetry falls back to default delay when retry-after is non-numeric", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "not-a-number" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    // Default delay for first retry (i=0) is (0+1)*2000 = 2000ms
    assert.ok(
      elapsed >= 1900,
      `Expected at least 1900ms fallback delay, got ${elapsed}ms`,
    )
  })

  it("system transform does not inject when system already contains prefix", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      assert.equal(
        typeof plugin["experimental.chat.system.transform"],
        "function",
      )

      const transform = plugin["experimental.chat.system.transform"] as (
        input: { model?: { providerID?: string } },
        output: { system: string[] },
      ) => Promise<void>

      const prefixed =
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nExisting"
      const output = { system: [prefixed] }

      await transform({ model: { providerID: "anthropic" } }, output)

      assert.deepEqual(output.system, [prefixed])
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("system transform injects prefix at most once when already present", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      const transform = plugin["experimental.chat.system.transform"] as (
        input: { model?: { providerID?: string } },
        output: { system: string[] },
      ) => Promise<void>

      const output = {
        system: [
          "Existing instruction",
          "You are Claude Code, Anthropic's official CLI for Claude.\n\nAlready present",
        ],
      }

      await transform({ model: { providerID: "anthropic" } }, output)

      const occurrences = output.system
        .join("\n")
        .match(/You are Claude Code, Anthropic's official CLI for Claude\./g)
      assert.equal(occurrences?.length, 1)
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("plugin calls unref on the sync interval timer", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome

    let unrefCalled = false
    const fakeTimer = {
      unref() {
        unrefCalled = true
      },
    }
    globalThis.setInterval = (() => fakeTimer) as unknown as typeof setInterval

    try {
      await helpers.default({} as never)
      assert.ok(
        unrefCalled,
        "Expected .unref() to be called on the interval timer",
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch normalizes Anthropic messages URL to the official beta route", async () => {
    const originalNow = Date.now
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    Date.now = () => 1_700_000_000_000
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    let forwardedInput: RequestInfo | URL | undefined

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        forwardedInput = input
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      assert.equal(typeof typedPlugin.auth?.loader, "function")
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      const originalInput = "https://api.anthropic.com/v1/messages"
      await authConfig.fetch(originalInput, {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      })

      assert.equal(
        getRequestUrl(forwardedInput),
        "https://api.anthropic.com/v1/messages?beta=true",
      )
    } finally {
      Date.now = originalNow
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch injects billing text into system and W6H-style metadata.user_id", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    let capturedInit: RequestInit | undefined

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
        {
          accountUuid: "acct-from-credentials",
          userID: "device-from-credentials",
        },
        {
          accountUuid: "acct-123",
          userID: "device-456",
        },
      )
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        capturedInit = init
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      await authConfig.fetch(
        "https://api.anthropic.com/v1/messages?beta=true",
        {
          method: "POST",
          headers: {
            "anthropic-beta": "effort-2025-11-24,structured-outputs-2025-12-15",
          },
          body: JSON.stringify({
            output_config: {
              effort: "medium",
              format: {
                type: "json_schema",
                schema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
            temperature: 1,
            max_tokens: 32000,
            tools: [],
            stream: true,
            metadata: { trace_id: "trace-1" },
            system: "Existing system",
            model: "claude-haiku-4-5-20251001",
            messages: [{ role: "user", content: "Hello from request body" }],
          }),
        },
      )

      assert.ok(capturedInit)
      const headers = new Headers(capturedInit.headers)
      assert.equal(headers.get("x-anthropic-billing-header"), null)
      assert.equal(headers.get("accept"), "application/json")
      assert.equal(
        headers.get("anthropic-dangerous-direct-browser-access"),
        "true",
      )
      assert.equal(headers.get("anthropic-version"), "2023-06-01")
      assert.equal(headers.get("content-type"), "application/json")
      assert.equal(headers.get("x-app"), "cli")
      assert.equal(headers.get("x-stainless-arch"), process.arch)
      assert.equal(headers.get("x-stainless-lang"), "js")
      assert.equal(headers.get("x-stainless-package-version"), "0.74.0")
      assert.equal(headers.get("x-stainless-retry-count"), "0")
      assert.equal(headers.get("x-stainless-runtime"), "node")
      assert.equal(headers.get("x-stainless-runtime-version"), process.version)
      assert.equal(headers.get("x-stainless-timeout"), "600")
      assert.ok(
        headers.get("anthropic-beta")?.includes("redact-thinking-2026-02-12"),
      )
      assert.ok(
        headers.get("anthropic-beta")?.includes("advanced-tool-use-2025-11-20"),
      )
      assert.equal(
        headers.get("anthropic-beta")?.includes("effort-2025-11-24"),
        false,
      )
      assert.ok(
        headers
          .get("anthropic-beta")
          ?.includes("structured-outputs-2025-12-15"),
      )
      assert.match(
        String(headers.get("x-client-request-id")),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      )
      assert.match(
        String(headers.get("x-claude-code-session-id")),
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      )

      const rawBody = String(capturedInit.body)
      const parsed = JSON.parse(rawBody) as {
        metadata: { user_id: string }
        output_config: {
          effort?: string
          format: { type: string }
        }
        temperature: number
        tools: unknown[]
        system: Array<{
          text: string
          type: string
          cache_control?: { type: string }
        }>
        messages: Array<{
          role: string
          content: Array<{
            type: string
            text?: string
            tool_use_id?: string
            cache_control?: { type: string; scope?: string; ttl?: string }
            edits?: Array<{ old_text: string; new_text: string }>
          }>
        }>
        stream: boolean
      }
      assert.deepEqual(
        Object.keys(JSON.parse(rawBody) as Record<string, unknown>),
        [
          "model",
          "messages",
          "system",
          "tools",
          "metadata",
          "max_tokens",
          "temperature",
          "output_config",
          "stream",
        ],
      )
      assert.ok(
        /^x-anthropic-billing-header: cc_version=2\.1\.88\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/.test(
          parsed.system[0].text,
        ),
      )
      assert.deepEqual(parsed.system[1], {
        type: "text",
        text: "Existing system",
        cache_control: { type: "ephemeral" },
      })
      assert.deepEqual(parsed.tools, [])
      assert.equal(parsed.temperature, 1)
      assert.equal(parsed.output_config.effort, undefined)
      assert.equal(parsed.output_config.format.type, "json_schema")
      assert.deepEqual(parsed.messages[0]?.content[0]?.cache_control, {
        type: "ephemeral",
      })

      const metadata = JSON.parse(parsed.metadata.user_id) as {
        account_uuid: string
        device_id: string
        session_id: string
      }
      assert.equal(metadata.device_id, "device-456")
      assert.equal(metadata.account_uuid, "acct-123")
      assert.equal(headers.get("x-claude-code-session-id"), metadata.session_id)
      assert.match(
        metadata.session_id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch omits attribution header text when CLAUDE_CODE_ATTRIBUTION_HEADER is falsy", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const originalAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0"
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    let capturedInit: RequestInit | undefined

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
        {
          accountUuid: "acct-from-credentials",
          userID: "device-from-credentials",
        },
        {
          accountUuid: "acct-123",
          userID: "device-456",
        },
      )
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        capturedInit = init
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      await authConfig.fetch(
        "https://api.anthropic.com/v1/messages?beta=true",
        {
          method: "POST",
          body: JSON.stringify({
            system: "Existing system",
            model: "claude-haiku-4-5-20251001",
            messages: [{ role: "user", content: "Hello from request body" }],
          }),
        },
      )

      assert.ok(capturedInit)
      const parsed = JSON.parse(String(capturedInit.body)) as {
        system: Array<{
          text: string
          type: string
          cache_control?: { type: string; scope?: string; ttl?: string }
        }>
      }
      assert.deepEqual(parsed.system, [
        {
          type: "text",
          text: "Existing system",
          cache_control: { type: "ephemeral" },
        },
      ])
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      if (typeof originalAttribution === "string") {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttribution
      } else {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      }
      if (typeof originalEntrypoint === "string") {
        process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
      } else {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      }
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch fails when official Claude device_id is unavailable", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    let fetchCalled = false

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
        {
          accountUuid: "acct-456",
        },
        null,
      )
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        void init
        fetchCalled = true
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      await assert.rejects(
        authConfig.fetch("https://api.anthropic.com/v1/messages?beta=true", {
          method: "POST",
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            messages: [
              { role: "user", content: "No official user id present" },
            ],
          }),
        }),
        /Claude Code official device_id is unavailable/u,
      )
      assert.equal(fetchCalled, false)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })
})

describe("auth hook — account resolution", () => {
  it("defaults to Account 1 when no input is provided", () => {
    assert.equal(resolveAccount(accounts, undefined).label, "Account 1")
  })

  it("selects Account 2 by its source key", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-b28bbb7c").label,
      "Account 2",
    )
  })

  it("selects Account 3 by its source key", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-abc123").label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when source doesn't match any account", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-unknown").label,
      "Account 1",
    )
  })

  it("returns the correct credentials for the resolved account", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-b28bbb7c").credentials
        .accessToken,
      "at-2",
    )
  })

  it("works correctly when only one account exists", () => {
    const single = [
      {
        label: "Account 1",
        source: "Claude Code-credentials",
        credentials: makeCreds(),
      },
    ]
    assert.equal(resolveAccount(single, undefined).label, "Account 1")
    assert.equal(resolveAccount(single, "nonexistent").label, "Account 1")
  })
})

describe("auth hook — select prompt options", () => {
  it("builds one option per account", () => {
    assert.equal(buildSelectOptions(accounts, accounts[0].source).length, 3)
  })

  it("uses label as display text and source as value", () => {
    const options = buildSelectOptions(accounts, accounts[0].source)
    assert.equal(options[0].label, "Account 1")
    assert.equal(options[0].value, "Claude Code-credentials")
    assert.equal(options[1].label, "Account 2")
    assert.equal(options[1].value, "Claude Code-credentials-b28bbb7c")
  })

  it("marks the active account with (active) in its hint", () => {
    const options = buildSelectOptions(
      accounts,
      "Claude Code-credentials-b28bbb7c",
    )
    assert.ok(options[1].hint.includes("(active)"))
    assert.ok(!options[0].hint.includes("(active)"))
    assert.ok(!options[2].hint.includes("(active)"))
  })

  it("shows no prompts when only one account exists", () => {
    const single = [accounts[0]]
    const prompts =
      single.length > 1 ? buildSelectOptions(single, single[0].source) : []
    assert.deepEqual(prompts, [])
  })

  it("shows prompts when multiple accounts exist", () => {
    const prompts =
      accounts.length > 1
        ? buildSelectOptions(accounts, accounts[0].source)
        : []
    assert.equal(prompts.length, 3)
  })
})

describe("auth hook — authorize callback", () => {
  it("returns url as empty string", () => {
    assert.equal(buildAuthorizeResult(accounts[0]).url, "")
  })

  it("returns method: auto", () => {
    assert.equal(buildAuthorizeResult(accounts[0]).method, "auto")
  })

  it("instructions mention the chosen account label", () => {
    assert.ok(
      buildAuthorizeResult(accounts[1]).instructions.includes("Account 2"),
    )
  })

  it("callback returns type: success", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[0]).callback()).type,
      "success",
    )
  })

  it("callback returns provider: anthropic", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[0]).callback()).provider,
      "anthropic",
    )
  })

  it("callback returns the account's access token", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[1]).callback()).access,
      "at-2",
    )
  })

  it("callback returns the account's refresh token", async () => {
    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: makeCreds({ refreshToken: "rt-specific" }),
    }
    assert.equal(
      (await buildAuthorizeResult(account).callback()).refresh,
      "rt-specific",
    )
  })

  it("callback returns the account's expiry timestamp", async () => {
    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: makeCreds({ expiresAt: 1700000000000 }),
    }
    assert.equal(
      (await buildAuthorizeResult(account).callback()).expires,
      1700000000000,
    )
  })
})

describe("syncToPath", () => {
  const tmp = join(tmpdir(), `opencode-test-${process.pid}`)

  it("writes anthropic credentials to auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    const creds = makeCreds({
      accessToken: "at-write",
      refreshToken: "rt-write",
      expiresAt: 1700000000000,
    })
    syncToPath(authPath, creds, realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.deepEqual(written.anthropic, {
      type: "oauth",
      access: "at-write",
      refresh: "rt-write",
      expires: 1700000000000,
    })
    rmSync(tmp, { recursive: true, force: true })
  })

  it("preserves other providers already in auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(
      authPath,
      JSON.stringify({
        "github-copilot": { type: "oauth", access: "gh-token" },
      }),
      "utf-8",
    )
    syncToPath(authPath, makeCreds(), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.ok(written["github-copilot"])
    assert.equal(written["github-copilot"].access, "gh-token")
    assert.ok(written.anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("starts fresh when existing auth.json contains invalid JSON", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(authPath, "{ broken json {{", "utf-8")
    syncToPath(authPath, makeCreds({ accessToken: "at-fresh" }), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(written.anthropic.access, "at-fresh")
    assert.equal(Object.keys(written).length, 1)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates the directory if it does not exist", () => {
    const authPath = join(tmp, "deep", "nested", "auth.json")
    syncToPath(authPath, makeCreds(), realFs)
    assert.ok(JSON.parse(readFileSync(authPath, "utf-8")).anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })
})

function saveAccountSourceTo(stateFile: string, source: string): void {
  const dir = join(stateFile, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(stateFile, source, "utf-8")
}

function loadPersistedAccountSourceFrom(stateFile: string): string | null {
  try {
    if (existsSync(stateFile)) {
      return readFileSync(stateFile, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

function resolveStartupAccount(
  candidateAccounts: Account[],
  persistedSource: string | null,
): Account {
  return (
    (persistedSource &&
      candidateAccounts.find((a) => a.source === persistedSource)) ||
    candidateAccounts[0]
  )
}

describe("account persistence — saveAccountSource / loadPersistedAccountSource", () => {
  const tmp = join(tmpdir(), `opencode-persist-test-${process.pid}`)
  const stateFile = join(tmp, "claude-account-source.txt")

  it("returns null when the state file does not exist", () => {
    try {
      rmSync(stateFile, { force: true })
    } catch {
      /* ignore */
    }
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
  })

  it("saves and loads the account source correctly", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials-b28bbb7c")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-b28bbb7c",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("overwrites a previously saved source", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials")
    saveAccountSourceTo(stateFile, "Claude Code-credentials-abc123")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-abc123",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns null when the state file is empty", () => {
    mkdirSync(tmp, { recursive: true })
    writeFileSync(stateFile, "   ", "utf-8")
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe("startup account selection — uses persisted source", () => {
  it("uses Account 1 when no source is persisted", () => {
    assert.equal(resolveStartupAccount(accounts, null).label, "Account 1")
  })

  it("restores Account 2 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c").label,
      "Account 2",
    )
  })

  it("restores Account 3 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-abc123").label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when the persisted source no longer exists", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-gone").label,
      "Account 1",
    )
  })

  it("restores correct credentials for the persisted account", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c")
        .credentials.accessToken,
      "at-2",
    )
  })
})

describe("authorize() — immediate syncAuthJson + saveAccountSource", () => {
  const tmp = join(tmpdir(), `opencode-authorize-test-${process.pid}`)

  it("auth.json reflects the chosen account immediately after authorize()", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    const stateFile = join(tmp, "claude-account-source.txt")

    const chosen = accounts[1] // Account 2
    syncToPath(authPath, chosen.credentials, realFs)
    saveAccountSourceTo(stateFile, chosen.source)

    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(written.anthropic.access, "at-2")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-b28bbb7c",
    )

    rmSync(tmp, { recursive: true, force: true })
  })

  it("a subsequent startup restores the account written by authorize()", () => {
    mkdirSync(tmp, { recursive: true })
    const stateFile = join(tmp, "claude-account-source.txt")

    saveAccountSourceTo(stateFile, "Claude Code-credentials-abc123")

    const restored = resolveStartupAccount(
      accounts,
      loadPersistedAccountSourceFrom(stateFile),
    )
    assert.equal(restored.label, "Account 3")
    assert.equal(restored.credentials.accessToken, "at-3")

    rmSync(tmp, { recursive: true, force: true })
  })
})

describe("refreshIfNeeded — token expiry", () => {
  it("returns fresh when token expires more than 60s from now", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 120_000 }),
        Date.now(),
      ),
      "fresh",
    )
  })

  it("returns expired when token expires in less than 60s", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 30_000 }),
        Date.now(),
      ),
      "expired",
    )
  })

  it("returns expired when token is already past expiry", () => {
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: Date.now() - 1000 }), Date.now()),
      "expired",
    )
  })

  it("returns expired when token expires exactly at the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_000 }), now),
      "expired",
    )
  })

  it("returns fresh when token expires exactly 1ms past the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_001 }), now),
      "fresh",
    )
  })
})
