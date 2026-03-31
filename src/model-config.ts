export interface ModelOverride {
  exclude?: string[]
  add?: string[]
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const EFFORT_BETA = "effort-2025-11-24"
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15"

export const config: ModelConfig = {
  ccVersion: "2.1.88",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "advanced-tool-use-2025-11-20",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  modelOverrides: {
    "opus-4-5": {
      add: [EFFORT_BETA],
    },
    "4-6": {
      add: [EFFORT_BETA],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}

export function supportsEffort(modelId: string): boolean {
  if (!modelId) return false
  const override = getModelOverride(modelId)
  return override?.add?.includes(EFFORT_BETA) ?? false
}
