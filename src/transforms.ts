import { buildBillingHeaderValue, fillCchInSerializedBody } from "./signing.ts"
import { config, getModelOverride } from "./model-config.ts"
import { isEnable1hCacheTTL } from "./plugin-config.ts"

const TOOL_PREFIX = "mcp_"

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>
type ContentBlock = { type?: string; text?: string } & Record<string, unknown>
type Message = {
  role?: string
  content?: string | ContentBlock[]
}

export interface TransformIdentitySeed {
  deviceId: string
  accountUuid: string
  sessionId: string
}

export interface TransformBodyOptions {
  anonymizeIdentity?: boolean
  identitySeed?: TransformIdentitySeed
}

function ensureMetadataUserId(
  parsed: Record<string, unknown>,
  identitySeed?: TransformIdentitySeed,
): void {
  if (!identitySeed) {
    return
  }

  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    parsed.metadata = {}
  }

  const metadataRecord = parsed.metadata as Record<string, unknown>
  let existing: Record<string, unknown> = {}
  if (typeof metadataRecord.user_id === "string") {
    try {
      existing = JSON.parse(metadataRecord.user_id) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }

  metadataRecord.user_id = JSON.stringify({
    ...existing,
    device_id: identitySeed.deviceId,
    account_uuid: identitySeed.accountUuid,
    session_id: identitySeed.sessionId,
  })
}

function anonymizeMetadataUserId(
  parsed: Record<string, unknown>,
  options: TransformBodyOptions | undefined,
): void {
  if (!options?.identitySeed) {
    return
  }

  ensureMetadataUserId(parsed, options.identitySeed)
  if (!options.anonymizeIdentity) {
    return
  }

  const metadataRecord = parsed.metadata as Record<string, unknown>
  if (typeof metadataRecord.user_id !== "string") {
    return
  }

  try {
    const userId = JSON.parse(metadataRecord.user_id) as Record<string, unknown>
    metadataRecord.user_id = JSON.stringify({
      ...userId,
      device_id: options.identitySeed.deviceId,
      account_uuid: options.identitySeed.accountUuid,
      session_id: options.identitySeed.sessionId,
    })
  } catch {
    // Leave malformed metadata untouched
  }
}

export function repairToolPairs(messages: Message[]): Message[] {
  // Collect all tool_use ids and tool_result tool_use_ids
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const id = block["id"]
      if (block.type === "tool_use" && typeof id === "string") {
        toolUseIds.add(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        toolResultIds.add(toolUseId)
      }
    }
  }

  // Find orphaned IDs
  const orphanedUses = new Set<string>()
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id)
  }
  const orphanedResults = new Set<string>()
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id)
  }

  // Early return if nothing to fix
  if (orphanedUses.size === 0 && orphanedResults.size === 0) {
    return messages
  }

  // Filter orphaned blocks and remove messages with empty content arrays
  return messages
    .map((message) => {
      if (!Array.isArray(message.content)) return message
      const filtered = message.content.filter((block) => {
        const id = block["id"]
        if (block.type === "tool_use" && typeof id === "string") {
          return !orphanedUses.has(id)
        }
        const toolUseId = block["tool_use_id"]
        if (block.type === "tool_result" && typeof toolUseId === "string") {
          return !orphanedResults.has(toolUseId)
        }
        return true
      })
      return { ...message, content: filtered }
    })
    .filter(
      (message) =>
        !(Array.isArray(message.content) && message.content.length === 0),
    )
}

type CacheControl = { type: string; ttl?: string; scope?: string }

/**
 * Upgrade existing `cache_control` blocks in system, tools, and messages
 * to include `ttl: '1h'` when the 1h cache TTL feature is enabled.
 *
 * We intentionally do NOT add `scope: 'global'` here. Global scope requires
 * all preceding blocks to be globally scoped too, and our transformed request
 * shape can render tool blocks before later system blocks. Adding
 * `scope: 'global'` in this generic upgrade step therefore causes ordering
 * violations that Anthropic rejects.
 *
 * Rules:
 * - Only upgrades blocks that ALREADY have a `cache_control` field —
 *   never injects cache_control where one doesn't exist.
 * - Skips the billing header (system[0]) which must never carry
 *   cache_control (matches official cacheScope=null).
 */
function applyCacheControlUpgrades(parsed: {
  system?: SystemEntry[]
  tools?: Array<Record<string, unknown>>
  messages?: Message[]
}): void {
  if (!isEnable1hCacheTTL()) return

  const upgrade = (block: Record<string, unknown>): void => {
    const cc = block.cache_control as CacheControl | undefined
    if (!cc || typeof cc !== "object" || cc.type !== "ephemeral") return
    block.cache_control = { ...cc, ttl: "1h" }
  }

  // System blocks — skip index 0 (billing header, must stay without cache_control)
  if (Array.isArray(parsed.system)) {
    for (let i = 1; i < parsed.system.length; i++) {
      upgrade(parsed.system[i] as Record<string, unknown>)
    }
  }

  // Tool schemas
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      upgrade(tool)
    }
  }

  // Message content blocks
  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        upgrade(block as Record<string, unknown>)
      }
    }
  }
}

export function transformBody(
  body: BodyInit | null | undefined,
  options?: TransformBodyOptions,
): BodyInit | null | undefined {
  if (typeof body !== "string") {
    return body
  }

  try {
    const parsed = JSON.parse(body) as {
      model?: string
      system?: SystemEntry[]
      thinking?: Record<string, unknown>
      // eslint-disable-next-line @typescript-eslint/naming-convention
      output_config?: Record<string, unknown>
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{
        role?: string
        content?:
          | string
          | Array<{ type?: string; text?: string } & Record<string, unknown>>
      }>
    } & Record<string, unknown>

    anonymizeMetadataUserId(parsed, options)

    // --- Billing header: inject as system[0] (no cache_control) ---
    const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli"
    const billingHeader = buildBillingHeaderValue(
      (parsed.messages ?? []) as Array<{
        role?: string
        content?: string | Array<{ type?: string; text?: string }>
      }>,
      version,
      entrypoint,
    )

    if (!Array.isArray(parsed.system)) {
      parsed.system = []
    }

    // Remove any existing billing header entries
    parsed.system = parsed.system.filter(
      (e) =>
        !(
          e.type === "text" &&
          typeof e.text === "string" &&
          e.text.startsWith("x-anthropic-billing-header")
        ),
    )

    // Insert billing header as system[0], without cache_control
    parsed.system.unshift({ type: "text", text: billingHeader })

    // --- Split identity prefix into its own system entry ---
    // OpenCode's system.transform hook prepends the identity string, but
    // OpenCode then concatenates all system entries into a single text block.
    // Anthropic's API requires the identity string as a separate entry for
    // OAuth validation (see issue #98).
    const splitSystem: SystemEntry[] = []
    for (const entry of parsed.system) {
      if (
        entry.type === "text" &&
        typeof entry.text === "string" &&
        entry.text.startsWith(SYSTEM_IDENTITY) &&
        entry.text.length > SYSTEM_IDENTITY.length
      ) {
        const rest = entry.text
          .slice(SYSTEM_IDENTITY.length)
          .replace(/^\n+/, "")
        // Preserve all properties except text (e.g. cache_control)
        const { text: _text, ...entryProps } = entry
        // Only keep cache_control on the remainder block to avoid exceeding
        // the API limit of 4 cache_control blocks per request.
        const { cache_control: _cc, ...identityProps } = entryProps
        splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY })
        if (rest.length > 0) {
          splitSystem.push({ ...entryProps, text: rest })
        }
      } else {
        splitSystem.push(entry)
      }
    }
    parsed.system = splitSystem

    // --- Relocate non-core system entries to user messages ---
    // Anthropic's API now validates the system prompt for OAuth-authenticated
    // requests that use Claude Code billing.  Third-party system prompts
    // (like OpenCode's) trigger a 400 "out of extra usage" rejection when
    // they appear inside the system[] array alongside the identity prefix.
    //
    // Work-around: keep only the billing header and identity prefix in
    // system[], and prepend all other system content to the first user
    // message where it is functionally equivalent but avoids the check.
    const BILLING_PREFIX = "x-anthropic-billing-header"
    const keptSystem: SystemEntry[] = []
    const movedTexts: string[] = []
    for (const entry of parsed.system) {
      const txt = typeof entry === "string" ? entry : (entry.text ?? "")
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
        keptSystem.push(entry)
      } else if (txt.length > 0) {
        movedTexts.push(txt)
      }
    }
    if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
      const firstUser = parsed.messages.find((m) => m.role === "user")
      if (firstUser) {
        parsed.system = keptSystem
        const prefix = movedTexts.join("\n\n")
        if (typeof firstUser.content === "string") {
          firstUser.content = prefix + "\n\n" + firstUser.content
        } else if (Array.isArray(firstUser.content)) {
          firstUser.content.unshift({ type: "text", text: prefix })
        }
      }
    }

    // Strip effort for models that don't support it (e.g. haiku).
    // OpenCode sends { output_config: { effort: "high" } } but haiku
    // rejects the effort parameter with a 400 error.
    const modelId = parsed.model ?? ""
    const override = getModelOverride(modelId)
    if (override?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort
        if (Object.keys(parsed.output_config).length === 0) {
          delete parsed.output_config
        }
      }
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort
        if (Object.keys(parsed.thinking).length === 0) {
          delete parsed.thinking
        }
      }
    }

    // Anthropic's OAuth billing validation rejects lowercase tool names
    // when multiple tools are present. Claude Code uses PascalCase after
    // the mcp_ prefix (e.g. mcp_Bash, mcp_Read). Apply the same convention.
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }))
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block
            }

            return { ...block, name: prefixName(block.name) }
          }),
        }
      })
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = repairToolPairs(parsed.messages)
    }

    // Upgrade cache_control blocks with 1h TTL + global scope when enabled
    applyCacheControlUpgrades(
      parsed as {
        system?: SystemEntry[]
        tools?: Array<Record<string, unknown>>
        messages?: Message[]
      },
    )

    return fillCchInSerializedBody(JSON.stringify(parsed))
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

export function transformResponseStream(response: Response): Response {
  if (!response.body) {
    return response
  }

  // Don't wrap error responses through the SSE parser — pass them through
  // with only tool-prefix stripping on the raw body. This preserves error
  // messages for OpenCode / AI SDK to handle properly.
  if (!response.ok) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        const text = decoder.decode(value, { stream: true })
        controller.enqueue(encoder.encode(stripToolPrefix(text)))
      },
    })

    return new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
          return
        }

        const { done, value } = await reader.read()

        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
            buffer = ""
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
