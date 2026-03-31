import { createHash } from "node:crypto"
import { supportsEffort } from "./model-config.ts"
import { getWorkload } from "./workload.ts"

const TOOL_PREFIX = "mcp_"
const PROMPT_MARKER_SEED_PREFIX = "59cf53e54c78"
const CCH_SLOT = "cch=00000"
const CCH_SEED = 0x6e52736ac806831en
const XXH64_MASK = 0xffffffffffffffffn
const XXH64_PRIME_1 = 0x9e3779b185ebca87n
const XXH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn
const XXH64_PRIME_3 = 0x165667b19e3779f9n
const XXH64_PRIME_4 = 0x85ebca77c2b2ae63n
const XXH64_PRIME_5 = 0x27d4eb2f165667c5n
const REQUEST_KEY_ORDER = [
  "model",
  "messages",
  "system",
  "tools",
  "metadata",
  "max_tokens",
  "thinking",
  "temperature",
  "output_config",
  "stream",
] as const

export interface TransformContext {
  accountUuid?: string
  cliVersion: string
  deviceId: string
  sessionId: string
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEnvDefinedFalsy(envVar: string | boolean | undefined): boolean {
  if (envVar === undefined) {
    return false
  }

  if (typeof envVar === "boolean") {
    return !envVar
  }

  if (!envVar) {
    return false
  }

  return ["0", "false", "no", "off"].includes(envVar.toLowerCase().trim())
}

function normalizeSystemBlocks(system: unknown): Array<string | JsonObject> {
  if (typeof system === "string") {
    return [{ type: "text", text: system }]
  }

  if (!Array.isArray(system)) {
    return []
  }

  return system.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ type: "text", text: entry }]
    }

    return isJsonObject(entry) ? [entry] : []
  })
}

function getFirstUserMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return ""
  }

  for (const message of messages) {
    if (!isJsonObject(message) || message.role !== "user") {
      continue
    }

    if (typeof message.content === "string") {
      return message.content
    }

    if (!Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (
        isJsonObject(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return block.text
      }
    }
  }

  return ""
}

function getExtraMetadata(): JsonObject {
  const raw = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return isJsonObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function sanitizeOutputConfig(
  outputConfig: unknown,
  modelId: unknown,
): JsonObject | undefined | unknown {
  if (!isJsonObject(outputConfig)) {
    return outputConfig
  }

  if (typeof modelId !== "string" || !modelId || supportsEffort(modelId)) {
    return outputConfig
  }

  const sanitized = { ...outputConfig }
  delete sanitized.effort

  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function orderRequestKeys(parsed: JsonObject): JsonObject {
  const ordered: JsonObject = {}
  const seen = new Set<string>()

  for (const key of REQUEST_KEY_ORDER) {
    if (key in parsed) {
      ordered[key] = parsed[key]
      seen.add(key)
    }
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!seen.has(key)) {
      ordered[key] = value
    }
  }

  return ordered
}

function xxh64RotateLeft(value: bigint, bits: bigint): bigint {
  const shift = Number(bits)
  return (
    ((value << bits) & XXH64_MASK) |
    ((value & XXH64_MASK) >> BigInt(64 - shift))
  )
}

function xxh64Round(accumulator: bigint, input: bigint): bigint {
  let next = (accumulator + ((input * XXH64_PRIME_2) & XXH64_MASK)) & XXH64_MASK
  next = xxh64RotateLeft(next, 31n)
  return (next * XXH64_PRIME_1) & XXH64_MASK
}

function xxh64MergeRound(accumulator: bigint, value: bigint): bigint {
  let next = accumulator ^ xxh64Round(0n, value)
  next = (next * XXH64_PRIME_1 + XXH64_PRIME_4) & XXH64_MASK
  return next
}

function xxh64Avalanche(value: bigint): bigint {
  let next = value
  next ^= next >> 33n
  next = (next * XXH64_PRIME_2) & XXH64_MASK
  next ^= next >> 29n
  next = (next * XXH64_PRIME_3) & XXH64_MASK
  next ^= next >> 32n
  return next & XXH64_MASK
}

function readUint64LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getBigUint64(offset, true)
}

function readUint32LE(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return BigInt(view.getUint32(offset, true))
}

export function computeSeededCchHash(bodyBytes: Uint8Array): bigint {
  const length = bodyBytes.length
  let offset = 0
  let hash: bigint

  if (length >= 32) {
    let value1 = (CCH_SEED + XXH64_PRIME_1 + XXH64_PRIME_2) & XXH64_MASK
    let value2 = (CCH_SEED + XXH64_PRIME_2) & XXH64_MASK
    let value3 = CCH_SEED & XXH64_MASK
    let value4 = (CCH_SEED - XXH64_PRIME_1) & XXH64_MASK

    while (offset + 32 <= length) {
      value1 = xxh64Round(value1, readUint64LE(bodyBytes, offset))
      offset += 8
      value2 = xxh64Round(value2, readUint64LE(bodyBytes, offset))
      offset += 8
      value3 = xxh64Round(value3, readUint64LE(bodyBytes, offset))
      offset += 8
      value4 = xxh64Round(value4, readUint64LE(bodyBytes, offset))
      offset += 8
    }

    hash = (
      xxh64RotateLeft(value1, 1n) +
      xxh64RotateLeft(value2, 7n) +
      xxh64RotateLeft(value3, 12n) +
      xxh64RotateLeft(value4, 18n)
    ) & XXH64_MASK
    hash = xxh64MergeRound(hash, value1)
    hash = xxh64MergeRound(hash, value2)
    hash = xxh64MergeRound(hash, value3)
    hash = xxh64MergeRound(hash, value4)
  } else {
    hash = (CCH_SEED + XXH64_PRIME_5) & XXH64_MASK
  }

  hash = (hash + BigInt(length)) & XXH64_MASK

  while (offset + 8 <= length) {
    const lane = xxh64Round(0n, readUint64LE(bodyBytes, offset))
    hash ^= lane
    hash = (
      xxh64RotateLeft(hash, 27n) * XXH64_PRIME_1 +
      XXH64_PRIME_4
    ) & XXH64_MASK
    offset += 8
  }

  if (offset + 4 <= length) {
    hash ^= (readUint32LE(bodyBytes, offset) * XXH64_PRIME_1) & XXH64_MASK
    hash = (
      xxh64RotateLeft(hash, 23n) * XXH64_PRIME_2 +
      XXH64_PRIME_3
    ) & XXH64_MASK
    offset += 4
  }

  while (offset < length) {
    hash ^= (BigInt(bodyBytes[offset] ?? 0) * XXH64_PRIME_5) & XXH64_MASK
    hash = (xxh64RotateLeft(hash, 11n) * XXH64_PRIME_1) & XXH64_MASK
    offset += 1
  }

  return xxh64Avalanche(hash)
}

export function computeCch(bodyText: string): string {
  const bodyBytes = new TextEncoder().encode(bodyText)
  const hash = computeSeededCchHash(bodyBytes)
  return (hash & 0xfffffn).toString(16).padStart(5, "0")
}

export function fillCchInSerializedBody(bodyText: string): string {
  const slotIndex = bodyText.indexOf(CCH_SLOT)
  if (slotIndex === -1) {
    return bodyText
  }

  const cch = computeCch(bodyText)
  const cchStart = slotIndex + 4
  return `${bodyText.slice(0, cchStart)}${cch}${bodyText.slice(cchStart + 5)}`
}

export function getPromptMarker(
  firstUserMessageText: string,
  cliVersion: string,
): string {
  const chars = [4, 7, 20]
    .map((index) => firstUserMessageText[index] ?? "0")
    .join("")
  const seed = `${PROMPT_MARKER_SEED_PREFIX}${chars}${cliVersion}`
  return createHash("sha256").update(seed).digest("hex").slice(0, 3)
}

export function buildBillingHeaderValue(
  firstUserMessageText: string,
  cliVersion: string,
): string {
  return getAttributionHeader(firstUserMessageText, cliVersion).replace(
    /^x-anthropic-billing-header:\s*/u,
    "",
  )
}

export function buildBillingSystemText(
  firstUserMessageText: string,
  cliVersion: string,
): string {
  return getAttributionHeader(firstUserMessageText, cliVersion)
}

export function isAttributionHeaderEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)
}

export function getAttributionHeader(
  firstUserMessageText: string,
  cliVersion: string,
): string {
  if (!isAttributionHeaderEnabled()) {
    return ""
  }

  const marker = getPromptMarker(firstUserMessageText, cliVersion)
  const version = `${cliVersion}.${marker}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ""

  return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint}; cch=00000;${workloadPair}`
}

export function transformBody(
  body: BodyInit | null | undefined,
  context?: TransformContext,
): BodyInit | null | undefined {
  if (typeof body !== "string") {
    return body
  }

  try {
    const parsed = JSON.parse(body) as unknown
    if (!isJsonObject(parsed)) {
      return body
    }

    const request = parsed as {
      metadata?: unknown
      model?: string
      output_config?: unknown
      system?: unknown
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{
        content?: string | Array<Record<string, unknown>>
        role?: string
      }>
    }

    if (Array.isArray(request.tools)) {
      request.tools = request.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }

    if (Array.isArray(request.messages)) {
      request.messages = request.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block
            }

            return {
              ...block,
              name: `${TOOL_PREFIX}${block.name}`,
            }
          }),
        }
      })
    }

    const sanitizedOutputConfig = sanitizeOutputConfig(
      request.output_config,
      request.model,
    )
    if (typeof sanitizedOutputConfig === "undefined") {
      delete request.output_config
    } else {
      request.output_config = sanitizedOutputConfig
    }

    if (context) {
      const firstUserMessageText = getFirstUserMessageText(request.messages)
      const billingText = buildBillingSystemText(
        firstUserMessageText,
        context.cliVersion,
      )
      if (billingText) {
        request.system = [
          { type: "text", text: billingText },
          ...normalizeSystemBlocks(request.system),
        ]
      }

      const metadata = isJsonObject(request.metadata) ? request.metadata : {}
      request.metadata = {
        ...metadata,
        user_id: JSON.stringify({
          device_id: context.deviceId,
          account_uuid: context.accountUuid ?? "",
          session_id: context.sessionId,
          ...getExtraMetadata(),
        }),
      }
    }

    const serializedBody = JSON.stringify(orderRequestKeys(parsed))
    return fillCchInSerializedBody(serializedBody)
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}

export function transformResponseStream(response: Response): Response {
  if (!response.body) {
    return response
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
