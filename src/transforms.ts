import { createHash } from "node:crypto"
import { supportsEffort } from "./model-config.ts"
import { getWorkload } from "./workload.ts"
import { getBedrockExtraBodyParamsBetas } from "./betas.ts"

const TOOL_PREFIX = "mcp_"
const PROMPT_MARKER_SEED_PREFIX = "59cf53e54c78"
const CCH_SLOT = "cch=00000"
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"
const CLI_SYSTEM_PROMPT_PREFIXES = new Set([
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
])
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
  "tool_choice",
  "betas",
  "metadata",
  "max_tokens",
  "thinking",
  "temperature",
  "context_management",
  "output_config",
  "speed",
  "stream",
] as const
const EXTRA_BODY_PARAMS_INSERT_AFTER = "context_management"
const EXTRA_BODY_PARAMS_INSERT_BEFORE = ["output_config", "speed", "stream"] as const

export interface TransformContext {
  accountUuid?: string
  cliVersion: string
  deviceId: string
  sessionId: string
}

type JsonObject = Record<string, unknown>

type CacheControl = {
  scope?: "global"
  ttl?: "1h" | "5m"
  type: "ephemeral"
}

type CacheEditBlock = JsonObject & {
  type: "cache_edits"
}

type PromptCachingOptions = {
  newCacheEditBlock: CacheEditBlock | null
  pinnedCacheEdits: Array<{ block: CacheEditBlock; userMessageIndex: number }>
  querySource?: string
  skipCacheWrite: boolean
  skipGlobalCacheForSystemPrompt: boolean
}

type RequestTool = JsonObject & {
  defer_loading?: boolean
  isMcp?: boolean
  name?: string
}

type CachedMicrocompactState = {
  pendingCacheEdits: CacheEditBlock | null
  pinnedCacheEdits: Array<{ block: CacheEditBlock; userMessageIndex: number }>
}

const cachedMicrocompactState: CachedMicrocompactState = {
  pendingCacheEdits: null,
  pinnedCacheEdits: [],
}

type TransformRequest = JsonObject & {
  betas?: unknown
  context_management?: unknown
  max_tokens?: unknown
  messages?: Array<{
    content?: string | Array<Record<string, unknown>>
    role?: string
  }>
  metadata?: unknown
  model?: string
  output_config?: unknown
  speed?: unknown
  system?: unknown
  thinking?: unknown
  tool_choice?: unknown
  tools?: Array<{ name?: string } & Record<string, unknown>>
}

type SystemPromptBlock = {
  cacheScope: "global" | "org" | null
  text: string
}

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

function getSystemBlockText(block: string | JsonObject): string | null {
  if (typeof block === "string") {
    return block
  }

  return typeof block.text === "string" ? block.text : null
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isCacheEditBlock(block: unknown): block is CacheEditBlock {
  return isJsonObject(block) && block.type === "cache_edits"
}

function shouldUseOneHourCacheTtl(querySource?: string): boolean {
  if (process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK) {
    return true
  }

  if (!querySource) {
    return false
  }

  const allowlist = process.env.CLAUDE_CODE_PROMPT_CACHE_1H_ALLOWLIST
  if (!allowlist) {
    return false
  }

  return allowlist
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry.endsWith("*")) {
        return querySource.startsWith(entry.slice(0, -1))
      }

      return querySource === entry
    })
}

function getCacheControl(options?: {
  querySource?: string
  scope?: "global" | "org" | null
}): CacheControl {
  const cacheControl: CacheControl = { type: "ephemeral" }

  if (shouldUseOneHourCacheTtl(options?.querySource)) {
    cacheControl.ttl = "1h"
  }

  if (options?.scope === "global") {
    cacheControl.scope = "global"
  }

  return cacheControl
}

function addCacheControlToBlock(
  block: unknown,
  options?: { querySource?: string; scope?: "global" | "org" | null },
): unknown {
  if (!isJsonObject(block)) {
    return block
  }

  return {
    ...block,
    cache_control: getCacheControl(options),
  }
}

function isAssistantCacheIneligible(block: unknown): boolean {
  if (!isJsonObject(block)) {
    return false
  }

  if (block.type === "thinking" || block.type === "redacted_thinking") {
    return true
  }

  if (block.type === "text" && block.is_connector === true) {
    return true
  }

  return false
}

function isAttributionSystemText(text: string): boolean {
  return text.startsWith("x-anthropic-billing-header")
}

function isCliSystemPrefixText(text: string): boolean {
  return CLI_SYSTEM_PROMPT_PREFIXES.has(text)
}

function shouldUseGlobalCacheScope(): boolean {
  return (
    process.env.ANTHROPIC_API_PROVIDER === "firstParty" &&
    !isEnvDefinedFalsy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

function isMainThreadQuerySource(querySource?: string): boolean {
  return (
    querySource === "repl_main_thread" ||
    querySource?.startsWith("repl_main_thread:outputStyle:") === true
  )
}

function shouldUseCachedMicrocompact(
  options: PromptCachingOptions,
): boolean {
  // Official source: ../src/services/api/claude.ts:addCacheBreakpoints(...)
  // gates cache-editing API-layer behavior behind
  // `useCachedMC = cachedMCEnabled && getAPIProvider() === 'firstParty' && options.querySource === 'repl_main_thread'`.
  // Official source: ../src/services/compact/microCompact.ts further explains
  // cached MC is main-thread-only via isMainThreadSource(querySource).
  // The local plugin only models the request-visible/API-layer subset here,
  // so we require the source-backed provider + main-thread conditions before
  // emitting cache_edits-derived request mutations.
  return (
    process.env.ANTHROPIC_API_PROVIDER === "firstParty" &&
    isMainThreadQuerySource(options.querySource)
  )
}

function splitSystemPromptPrefix(
  system: unknown,
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const normalized = normalizeSystemBlocks(system)
  const textBlocks = normalized
    .map((block) => ({ raw: block, text: getSystemBlockText(block) }))
    .filter((block): block is { raw: string | JsonObject; text: string } =>
      typeof block.text === "string",
    )

  if (textBlocks.length === 0) {
    return []
  }

  const attribution = textBlocks.find((block) => isAttributionSystemText(block.text))
  const cliPrefix = textBlocks.find((block) => isCliSystemPrefixText(block.text))
  const remainingTexts = textBlocks
    .filter(
      (block) =>
        !isAttributionSystemText(block.text) && !isCliSystemPrefixText(block.text),
    )
    .map((block) => block.text)

  const shouldGlobalScope = shouldUseGlobalCacheScope()
  const boundaryIndex = remainingTexts.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  if (shouldGlobalScope && options?.skipGlobalCacheForSystemPrompt) {
    const remainingWithoutBoundary = remainingTexts.filter(
      (text) => text !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    )

    const blocks: Array<SystemPromptBlock | null> = [
      attribution
        ? {
            text: attribution.text,
            cacheScope: null,
          }
        : null,
      cliPrefix
        ? {
            text: cliPrefix.text,
            cacheScope: "org",
          }
        : null,
      remainingWithoutBoundary.length > 0
        ? {
            text: remainingWithoutBoundary.join("\n\n"),
            cacheScope: "org",
          }
        : null,
    ]
    return blocks.flatMap((block) => (block && block.text ? [block] : []))
  }

  if (shouldGlobalScope && boundaryIndex !== -1) {
    const beforeBoundary = remainingTexts.slice(0, boundaryIndex)
    const afterBoundary = remainingTexts
      .slice(boundaryIndex + 1)
      .filter((text) => text !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

    const blocks: Array<SystemPromptBlock | null> = [
      attribution
        ? {
            text: attribution.text,
            cacheScope: null,
          }
        : null,
      cliPrefix
        ? {
            text: cliPrefix.text,
            cacheScope: null,
          }
        : null,
      beforeBoundary.length > 0
        ? {
            text: beforeBoundary.join("\n\n"),
            cacheScope: "global",
          }
        : null,
      afterBoundary.length > 0
        ? {
            text: afterBoundary.join("\n\n"),
            cacheScope: null,
          }
        : null,
    ]
    return blocks.flatMap((block) => (block && block.text ? [block] : []))
  }

  const blocks: Array<SystemPromptBlock | null> = [
    attribution
      ? {
          text: attribution.text,
          cacheScope: null,
        }
      : null,
    cliPrefix
      ? {
          text: cliPrefix.text,
          cacheScope: "org",
        }
      : null,
    remainingTexts.length > 0
      ? {
          text: remainingTexts.filter((text) => text !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join("\n\n"),
          cacheScope: "org",
        }
      : null,
  ]
  return blocks.flatMap((block) => (block && block.text ? [block] : []))
}

function getMessageRole(message: JsonObject): string | undefined {
  return typeof message.role === "string" ? message.role : undefined
}

function addCacheControlToMessageContent(
  content: unknown,
  role: string | undefined,
  options?: { querySource?: string; scope?: "global" | "org" | null },
): unknown {
  if (typeof content === "string") {
    return [
      {
        type: "text",
        text: content,
        cache_control: getCacheControl(options),
      },
    ]
  }

  if (!Array.isArray(content) || content.length === 0) {
    return content
  }

  const clonedContent = content.map((block) => cloneJsonValue(block))
  const markerIndex = [...clonedContent].reverse().findIndex((block) => {
    if (role !== "assistant") {
      return true
    }

    return !isAssistantCacheIneligible(block)
  })

  if (markerIndex === -1) {
    return clonedContent
  }

  const actualIndex = clonedContent.length - 1 - markerIndex
  clonedContent[actualIndex] = addCacheControlToBlock(clonedContent[actualIndex], options)
  return clonedContent
}

function applyPromptCachingToSystem(
  system: unknown,
  options?: { querySource?: string; skipGlobalCacheForSystemPrompt?: boolean },
): Array<string | JsonObject> {
  return splitSystemPromptPrefix(system, options).map((block) => {
    const systemBlock = {
      type: "text",
      text: block.text,
    }

    return block.cacheScope === null
      ? systemBlock
      : (addCacheControlToBlock(systemBlock, {
          querySource: options?.querySource,
          scope: block.cacheScope,
        }) as JsonObject)
  })
}

function insertBlockAfterToolResults(
  content: Array<Record<string, unknown>>,
  block: Record<string, unknown>,
): Array<Record<string, unknown>> {
  let insertIndex = content.length - 1

  for (let index = content.length - 1; index >= 0; index -= 1) {
    const candidate = content[index]
    if (isJsonObject(candidate) && candidate.type === "tool_result") {
      insertIndex = index + 1
      break
    }
  }

  const nextContent = [...content]
  nextContent.splice(insertIndex, 0, cloneJsonValue(block))

  if (insertIndex >= content.length) {
    nextContent.push({ text: ".", type: "text" })
  }

  return nextContent
}

function applyPinnedCacheEdits(
  messages: Array<Record<string, unknown>>,
  pinnedCacheEdits: PromptCachingOptions["pinnedCacheEdits"],
  seenDeleteRefs: Set<string>,
): Array<Record<string, unknown>> {
  if (pinnedCacheEdits.length === 0) {
    return messages
  }

  return messages.map((message, index) => {
    if (!isJsonObject(message) || !Array.isArray(message.content)) {
      return message
    }

    const matchingBlocks = pinnedCacheEdits
      .filter((entry) => entry.userMessageIndex === index)
      .map((entry) => deduplicateCacheEditBlock(entry.block, seenDeleteRefs))
      .filter((entry): entry is CacheEditBlock => entry !== null)

    if (matchingBlocks.length === 0) {
      return message
    }

    let content = message.content.map((block) => cloneJsonValue(block))
    for (const block of matchingBlocks) {
      content = insertBlockAfterToolResults(content, block)
    }

    return {
      ...message,
      content,
    }
  })
}

function deduplicateCacheEditBlock(
  block: CacheEditBlock,
  seenDeleteRefs: Set<string>,
): CacheEditBlock | null {
  const edits = Array.isArray(block.edits) ? block.edits : []
  const deduplicated = edits.flatMap((edit) => {
    if (!isJsonObject(edit)) {
      return []
    }

    const cacheReference =
      typeof edit.cache_reference === "string" ? edit.cache_reference : undefined

    if (!cacheReference) {
      return [edit]
    }

    if (seenDeleteRefs.has(cacheReference)) {
      return []
    }

    seenDeleteRefs.add(cacheReference)
    return [edit]
  })

  if (deduplicated.length === 0) {
    return null
  }

  return {
    ...cloneJsonValue(block),
    edits: deduplicated,
  }
}

function addCacheReferenceToToolResults(
  messages: Array<JsonObject>,
): Array<JsonObject> {
  // Official source citation:
  // - `.inspect-claude-code-2.1.88/src/services/api/claude.ts:3164-3207`
  //   After cache_edits insertion, official Claude Code adds top-level
  //   `cache_reference: tool_use_id` to `tool_result` blocks that are strictly
  //   before the last message containing any `cache_control` marker.
  let lastCacheControlMessageIndex = -1

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (isJsonObject(block) && "cache_control" in block) {
        lastCacheControlMessageIndex = index
      }
    }
  }

  if (lastCacheControlMessageIndex < 0) {
    return messages
  }

  return messages.map((message, index) => {
    if (
      index >= lastCacheControlMessageIndex ||
      getMessageRole(message) !== "user" ||
      !Array.isArray(message.content)
    ) {
      return message
    }

    let cloned = false
    const nextContent = message.content.map((block) => cloneJsonValue(block))

    for (let blockIndex = 0; blockIndex < nextContent.length; blockIndex += 1) {
      const block = nextContent[blockIndex]
      if (!isJsonObject(block) || block.type !== "tool_result") {
        continue
      }

      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : undefined
      if (!toolUseId) {
        continue
      }

      if (!cloned) {
        cloned = true
      }

      nextContent[blockIndex] = {
        ...block,
        cache_reference: toolUseId,
      }
    }

    if (!cloned) {
      return message
    }

    return {
      ...message,
      content: nextContent,
    }
  })
}

function getLastUserMessageIndex(messages: Array<JsonObject>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (getMessageRole(message) === "user") {
      return index
    }
  }

  return -1
}

function applyPromptCachingToMessages(
  messages: Array<JsonObject>,
  options: PromptCachingOptions,
): Array<JsonObject> {
  const transformed = messages.map((message) => ({ ...message }))

  if (transformed.length === 0) {
    return transformed
  }

  const markerIndex = options.skipCacheWrite
    ? Math.max(transformed.length - 2, 0)
    : transformed.length - 1
  const markerMessage = transformed[markerIndex]

  if (markerMessage) {
    markerMessage.content = addCacheControlToMessageContent(
      markerMessage.content,
      getMessageRole(markerMessage),
      {
        querySource: options.querySource,
        scope: "org",
      },
    )
  }

  if (!shouldUseCachedMicrocompact(options)) {
    return transformed
  }

  const seenDeleteRefs = new Set<string>()
  const withPinnedEdits = applyPinnedCacheEdits(
    transformed,
    options.pinnedCacheEdits,
    seenDeleteRefs,
  )

  const lastUserMessageIndex = getLastUserMessageIndex(withPinnedEdits)
  const newCacheEdit = options.newCacheEditBlock

  if (lastUserMessageIndex < 0 || !newCacheEdit) {
    return withPinnedEdits
  }

  const deduplicatedNewCacheEdit = deduplicateCacheEditBlock(
    newCacheEdit,
    seenDeleteRefs,
  )

  if (!deduplicatedNewCacheEdit) {
    return addCacheReferenceToToolResults(withPinnedEdits)
  }

  const withNewEdits = withPinnedEdits.map((message, index) => {
    if (index !== lastUserMessageIndex || !Array.isArray(message.content)) {
      return message
    }

    return {
      ...message,
      content: insertBlockAfterToolResults(message.content, deduplicatedNewCacheEdit),
    }
  })

  return addCacheReferenceToToolResults(withNewEdits)
}

function parsePinnedCacheEdits(metadata: unknown): PromptCachingOptions["pinnedCacheEdits"] {
  if (!isJsonObject(metadata) || !Array.isArray(metadata.pinned_cache_edits)) {
    return []
  }

  return metadata.pinned_cache_edits.flatMap((entry) => {
    if (!isJsonObject(entry) || !isCacheEditBlock(entry.block) || typeof entry.userMessageIndex !== "number") {
      return []
    }

    return [
      {
        block: cloneJsonValue(entry.block),
        userMessageIndex: entry.userMessageIndex,
      },
    ]
  })
}

function getNewCacheEditBlock(metadata: unknown): CacheEditBlock | null {
  if (isJsonObject(metadata) && isCacheEditBlock(metadata.cache_edit_block)) {
    return cloneJsonValue(metadata.cache_edit_block)
  }

  const raw = process.env.CLAUDE_CODE_CACHE_EDIT_BLOCK
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return isCacheEditBlock(parsed) ? cloneJsonValue(parsed) : null
  } catch {
    return null
  }
}

// Official source citation:
// - `.inspect-claude-code-2.1.88/src/services/compact/microCompact.ts`
//   exports module-level lifecycle helpers with these exact responsibilities:
//   `consumePendingCacheEdits()`, `getPinnedCacheEdits()`, `pinCacheEdits()`,
//   `markToolsSentToAPIState()`, `resetMicrocompactState()`.
// - The local plugin mirrors only the request-visible/API-layer subset here.
export function consumePendingCacheEdits(): CacheEditBlock | null {
  const edits = cachedMicrocompactState.pendingCacheEdits
  cachedMicrocompactState.pendingCacheEdits = null
  return edits ? cloneJsonValue(edits) : null
}

export function getPinnedCacheEdits(): PromptCachingOptions["pinnedCacheEdits"] {
  return cachedMicrocompactState.pinnedCacheEdits.map((entry) => ({
    block: cloneJsonValue(entry.block),
    userMessageIndex: entry.userMessageIndex,
  }))
}

export function pinCacheEdits(
  userMessageIndex: number,
  block: CacheEditBlock,
): void {
  cachedMicrocompactState.pinnedCacheEdits.push({
    block: cloneJsonValue(block),
    userMessageIndex,
  })
}

export function markToolsSentToAPIState(): void {
  cachedMicrocompactState.pendingCacheEdits = null
}

export function resetMicrocompactState(): void {
  cachedMicrocompactState.pendingCacheEdits = null
  cachedMicrocompactState.pinnedCacheEdits = []
}

function stagePendingCacheEdits(block: CacheEditBlock | null): void {
  cachedMicrocompactState.pendingCacheEdits = block ? cloneJsonValue(block) : null
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

function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // Official source citation:
  // - `.inspect-claude-code-2.1.88/src/services/api/claude.ts:272-331`
  //   `getExtraBodyParams(betaHeaders?)` reads `CLAUDE_CODE_EXTRA_BODY`, accepts
  //   only JSON objects, shallow-clones the parsed object, and merges
  //   `betaHeaders` into `anthropic_beta` without duplicates.
  const raw = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isJsonObject(parsed)) {
        result = { ...parsed }
      }
    } catch {
      result = {}
    }
  }

  if (betaHeaders && betaHeaders.length > 0) {
    const existingHeaders = Array.isArray(result.anthropic_beta)
      ? result.anthropic_beta.filter(
          (header): header is string => typeof header === "string",
        )
      : []
    const newHeaders = betaHeaders.filter(
      (header) => !existingHeaders.includes(header),
    )

    result.anthropic_beta =
      existingHeaders.length > 0 || newHeaders.length > 0
        ? [...existingHeaders, ...newHeaders]
        : result.anthropic_beta
  }

  return result
}

function getProviderExtraBodyBetas(model: unknown): string[] {
  // Official source: .inspect-claude-code-2.1.88/src/utils/betas.ts:379-383
  // defines getBedrockExtraBodyParamsBetas(model) and
  // .inspect-claude-code-2.1.88/src/services/api/claude.ts:1549-1557,1713,1723
  // routes Bedrock-only betas into extraBodyParams.anthropic_beta instead of the
  // normal top-level/body beta path.
  if (
    process.env.ANTHROPIC_API_PROVIDER !== "bedrock" ||
    typeof model !== "string"
  ) {
    return []
  }

  return getBedrockExtraBodyParamsBetas(model)
}

function buildPromptCachingOptions(metadata: unknown): PromptCachingOptions {
  const normalizedMetadata = isJsonObject(metadata) ? metadata : {}
  const metadataPinnedCacheEdits = parsePinnedCacheEdits(normalizedMetadata)
  const metadataCacheEditBlock = getNewCacheEditBlock(normalizedMetadata)

  if (metadataPinnedCacheEdits.length > 0) {
    cachedMicrocompactState.pinnedCacheEdits = metadataPinnedCacheEdits.map(
      (entry) => ({
        block: cloneJsonValue(entry.block),
        userMessageIndex: entry.userMessageIndex,
      }),
    )
  }

  if (metadataCacheEditBlock) {
    stagePendingCacheEdits(metadataCacheEditBlock)
  }

  return {
    newCacheEditBlock: consumePendingCacheEdits(),
    pinnedCacheEdits: getPinnedCacheEdits(),
    querySource:
      typeof normalizedMetadata.query_source === "string"
        ? normalizedMetadata.query_source
        : undefined,
    skipCacheWrite: normalizedMetadata.skip_cache_write === true,
    skipGlobalCacheForSystemPrompt:
      normalizedMetadata.skip_global_cache_for_system_prompt === true,
  }
}

function shouldDeferToolForGlobalCache(tool: RequestTool): boolean {
  return tool.defer_loading === true
}

function needsToolBasedCacheMarker(
  tools: TransformRequest["tools"],
): boolean {
  // Official source citation:
  // - `.inspect-claude-code-2.1.88/src/services/api/claude.ts:1207-1214`
  //   computes `needsToolBasedCacheMarker = useGlobalCacheFeature && filteredTools.some(t => t.isMcp === true && !willDefer(t))`.
  // - In the official client, `willDefer(t)` is `useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))`.
  // - The local plugin does not own Claude Code's tool-search planner or deferred-tool registry,
  //   so the exact source-backed subset we can observe on request tools is:
  //   MCP tool + not explicitly marked `defer_loading`.
  if (!shouldUseGlobalCacheScope() || !Array.isArray(tools)) {
    return false
  }

  return tools.some((tool) => {
    if (!isJsonObject(tool)) {
      return false
    }

    const requestTool = tool as RequestTool
    return requestTool.isMcp === true && !shouldDeferToolForGlobalCache(requestTool)
  })
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

function buildRequestSystem(
  system: unknown,
  context: TransformContext,
  options: PromptCachingOptions,
  messages: unknown,
  tools: TransformRequest["tools"],
): Array<string | JsonObject> {
  const firstUserMessageText = getFirstUserMessageText(messages)
  const billingText = buildBillingSystemText(firstUserMessageText, context.cliVersion)
  const skipGlobalCacheForSystemPrompt =
    options.skipGlobalCacheForSystemPrompt || needsToolBasedCacheMarker(tools)

  if (billingText) {
    return [
      { type: "text", text: billingText },
      ...applyPromptCachingToSystem(system, {
        querySource: options.querySource,
        skipGlobalCacheForSystemPrompt,
      }),
    ]
  }

  return applyPromptCachingToSystem(system, {
    querySource: options.querySource,
    skipGlobalCacheForSystemPrompt,
  })
}

function buildRequestMessages(
  messages: TransformRequest["messages"],
  options: PromptCachingOptions,
): TransformRequest["messages"] {
  if (!Array.isArray(messages)) {
    return messages
  }

  const result = applyPromptCachingToMessages(messages, options) as typeof messages

  if (
    Array.isArray(result) &&
    options.newCacheEditBlock
  ) {
    const lastUserMessageIndex = getLastUserMessageIndex(result as Array<JsonObject>)
    if (lastUserMessageIndex >= 0) {
      pinCacheEdits(lastUserMessageIndex, options.newCacheEditBlock)
    }
  }

  return result
}

function buildRequestMetadata(
  metadata: unknown,
  context: TransformContext,
): JsonObject {
  const normalizedMetadata = isJsonObject(metadata) ? metadata : {}

  return {
    ...normalizedMetadata,
    user_id: JSON.stringify({
      ...getExtraMetadata(),
      device_id: context.deviceId,
      account_uuid: context.accountUuid ?? "",
      session_id: context.sessionId,
    }),
  }
}

function applyExtraBodyParams(request: TransformRequest): void {
  // Official source citation:
  // - `.inspect-claude-code-2.1.88/src/services/api/claude.ts:1549-1728`
  //   `paramsFromContext(...)` builds `extraBodyParams = getExtraBodyParams(...)`
  //   and spreads `...extraBodyParams` after `context_management` but before
  //   `output_config` and `speed`. `output_config` is separately built from
  //   `extraBodyParams.output_config` and later overrides it; `speed` only
  //   overrides an extra-body `speed` when an explicit computed `speed` exists.
  const extraBodyParams = getExtraBodyParams(
    getProviderExtraBodyBetas(request.model),
  )

  const extraOutputConfig = isJsonObject(extraBodyParams.output_config)
    ? cloneJsonValue(extraBodyParams.output_config)
    : undefined
  const extraSpeed = extraBodyParams.speed

  delete extraBodyParams.output_config
  delete extraBodyParams.speed

  Object.assign(request, extraBodyParams)

  if (extraOutputConfig) {
    request.output_config = isJsonObject(request.output_config)
      ? { ...extraOutputConfig, ...request.output_config }
      : extraOutputConfig
  }

  if (typeof request.speed === "undefined" && typeof extraSpeed !== "undefined") {
    request.speed = cloneJsonValue(extraSpeed)
  }
}

function finalizeRequestBody(request: JsonObject): string {
  const serializedBody = JSON.stringify(orderRequestKeys(request))
  return fillCchInSerializedBody(serializedBody)
}

function orderRequestKeys(parsed: JsonObject): JsonObject {
  const ordered: JsonObject = {}
  const seen = new Set<string>()
  const extraBodyParamEntries: Array<[string, unknown]> = []

  for (const key of REQUEST_KEY_ORDER) {
    if (key in parsed) {
      if (key === EXTRA_BODY_PARAMS_INSERT_BEFORE[0]) {
        for (const [extraKey, extraValue] of extraBodyParamEntries) {
          ordered[extraKey] = extraValue
          seen.add(extraKey)
        }
      }

      ordered[key] = parsed[key]
      seen.add(key)
    }

    if (key === EXTRA_BODY_PARAMS_INSERT_AFTER) {
      for (const [entryKey, entryValue] of Object.entries(parsed)) {
        if (!seen.has(entryKey) && !REQUEST_KEY_ORDER.includes(entryKey as (typeof REQUEST_KEY_ORDER)[number])) {
          extraBodyParamEntries.push([entryKey, entryValue])
        }
      }
    }
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (!seen.has(key) && !extraBodyParamEntries.some(([extraKey]) => extraKey === key)) {
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

    const request = parsed as TransformRequest

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
      const promptCachingOptions = buildPromptCachingOptions(request.metadata)

      request.system = buildRequestSystem(
        request.system,
        context,
        promptCachingOptions,
        request.messages,
        request.tools,
      )
      request.messages = buildRequestMessages(
        request.messages,
        promptCachingOptions,
      )
      request.metadata = buildRequestMetadata(request.metadata, context)
    }

    applyExtraBodyParams(request)

    return finalizeRequestBody(parsed)
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
