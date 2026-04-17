import { createHash } from "node:crypto"

const BILLING_SALT = "59cf53e54c78"
const CCH_SLOT = "cch=00000"
const CCH_SEED = 0x6e52736ac806831en
const XXH64_MASK = 0xffffffffffffffffn
const XXH64_PRIME_1 = 0x9e3779b185ebca87n
const XXH64_PRIME_2 = 0xc2b2ae3d27d4eb4fn
const XXH64_PRIME_3 = 0x165667b19e3779f9n
const XXH64_PRIME_4 = 0x85ebca77c2b2ae63n
const XXH64_PRIME_5 = 0x27d4eb2f165667c5n

interface Message {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

/**
 * Extract text from the first user message's first text block.
 * Matches Claude Code's K19() function exactly: find the first message
 * with role "user", then return the text of its first text content block.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((m) => m.role === "user")
  if (!userMsg) return ""
  const content = userMsg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text")
    if (textBlock && textBlock.type === "text" && textBlock.text) {
      return textBlock.text
    }
  }
  return ""
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

/**
 * Compute cch from the final serialized request body while the placeholder
 * slot still contains cch=00000, matching the local recovered algorithm.
 */
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

/**
 * Compute the 3-char version suffix.
 * Samples characters at indices 4, 7, 20 from the message text (padding
 * with "0" when the message is shorter), then hashes with the billing salt
 * and version string.
 */
export function computeVersionSuffix(
  messageText: string,
  version: string,
): string {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("")
  const input = `${BILLING_SALT}${sampled}${version}`
  return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the billing header with the local placeholder cch slot. The actual cch
 * is filled after the full request body is serialized.
 */
export function buildBillingHeaderValue(
  messages: Message[],
  version: string,
  entrypoint: string,
): string {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(text, version)
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=00000;`
  )
}
