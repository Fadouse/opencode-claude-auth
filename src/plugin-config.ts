import { log } from "./logger.ts"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Plugin settings that can be set via opencode.json as an alternative
 * to environment variables.
 *
 * Priority: environment variable > opencode.json config > hardcoded default
 *
 * In opencode.json (project-level or ~/.config/opencode/opencode.json):
 *
 * ```json
 * {
 *   "agent": {
 *     "build": {
 *       "enable1mContext": true
 *     }
 *   }
 * }
 * ```
 */
export interface PluginSettings {
  enable1mContext?: boolean
  enable1hCacheTTL?: boolean
  apiKeyProvider?: {
    id: string
    baseURL: string
    apiKey: string
    smallModel?: string
  }
}

let settings: PluginSettings = {}

function parseApiKeyProvider(
  value: unknown,
): PluginSettings["apiKeyProvider"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const provider = value as Record<string, unknown>
  if (
    typeof provider.id !== "string" ||
    typeof provider.baseURL !== "string" ||
    typeof provider.apiKey !== "string"
  ) {
    return undefined
  }

  return {
    id: provider.id,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    smallModel:
      typeof provider.smallModel === "string" ? provider.smallModel : undefined,
  }
}

/**
 * Extract plugin settings from the opencode Config object.
 *
 * Scans all agent configs for our plugin-specific keys. AgentConfig has
 * a catch-all `[key: string]: unknown` index signature, so arbitrary
 * keys placed in agent configs are preserved through OpenCode's
 * config parser and passed to the plugin via the `config` hook.
 *
 * NOTE: OpenCode's Zod schema may relocate unknown top-level agent keys
 * into `agent.options`. We check both locations defensively so this
 * survives future config parser changes.
 *
 * The first boolean value found (in any agent) wins — even if `false`.
 */
export function applyOpencodeConfig(config: unknown): void {
  if (!config || typeof config !== "object") return

  const cfg = config as Record<string, unknown>
  const agents = cfg.agent as Record<string, unknown> | undefined

  if (!agents || typeof agents !== "object") return

  let foundPluginKey = false

  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig || typeof agentConfig !== "object") continue
    const agent = agentConfig as Record<string, unknown>
    const options = agent.options as Record<string, unknown> | undefined

    // Check top-level first, then fall back to options (where OpenCode's
    // Zod transform may relocate unknown keys)
    const val = agent.enable1mContext ?? options?.enable1mContext
    const cacheTTLVal = agent.enable1hCacheTTL ?? options?.enable1hCacheTTL

    if (typeof val === "boolean" && settings.enable1mContext === undefined) {
      settings.enable1mContext = val
      log("config_loaded", { enable1mContext: val })
      foundPluginKey = true
    }

    if (val !== undefined) {
      log("config_invalid_type", {
        key: "enable1mContext",
        expectedType: "boolean",
        actualType: typeof val,
      })
    }

    if (
      typeof cacheTTLVal === "boolean" &&
      settings.enable1hCacheTTL === undefined
    ) {
      settings.enable1hCacheTTL = cacheTTLVal
      log("config_loaded", { enable1hCacheTTL: cacheTTLVal })
      foundPluginKey = true
    }

    if (cacheTTLVal !== undefined && typeof cacheTTLVal !== "boolean") {
      log("config_invalid_type", {
        key: "enable1hCacheTTL",
        expectedType: "boolean",
        actualType: typeof cacheTTLVal,
      })
    }

    const apiKeyProviderRaw = agent.apiKeyProvider ?? options?.apiKeyProvider
    if (
      apiKeyProviderRaw !== undefined &&
      settings.apiKeyProvider === undefined
    ) {
      const parsed = parseApiKeyProvider(apiKeyProviderRaw)
      if (parsed) {
        settings.apiKeyProvider = parsed
        foundPluginKey = true
        log("config_loaded", { apiKeyProviderId: parsed.id })
      } else {
        log("config_invalid_type", {
          key: "apiKeyProvider",
          expectedType: "object{id,baseURL,apiKey}",
          actualType: typeof apiKeyProviderRaw,
        })
      }
    }
  }

  if (!foundPluginKey) {
    log("config_no_plugin_keys", {
      agentCount: Object.keys(agents).length,
    })
  }
}

/**
 * Whether 1M context should be enabled.
 *
 * Priority: ANTHROPIC_ENABLE_1M_CONTEXT env var > opencode.json > false
 */
export function isEnable1mContext(): boolean {
  const envVal = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
  if (envVal !== undefined) return envVal === "true"
  return settings.enable1mContext === true
}

/**
 * Whether 1h cache TTL should be enabled.
 *
 * When enabled, all existing cache_control blocks in the request body
 * (system, messages, tools) are upgraded with `ttl: '1h'` and
 * `scope: 'global'` to match the official CLI's getCacheControl()
 * behaviour for eligible first-party users.
 *
 * Priority: ANTHROPIC_ENABLE_1H_CACHE_TTL env var > opencode.json > false
 */
export function isEnable1hCacheTTL(): boolean {
  const envVal = process.env.ANTHROPIC_ENABLE_1H_CACHE_TTL
  if (envVal !== undefined) return envVal === "true"
  return settings.enable1hCacheTTL === true
}

export function resetPluginSettings(): void {
  settings = {}
}

export function getPluginSettings(): Readonly<PluginSettings> {
  return { ...settings }
}

export async function loadPluginSettingsFromFile(
  configPath?: string,
): Promise<boolean> {
  const candidates = [
    configPath,
    process.env.OPENCODE_CONFIG_PATH,
    join(process.env.HOME ?? "", ".config", "opencode", "opencode.json"),
  ].filter((value): value is string => Boolean(value))

  for (const path of candidates) {
    try {
      if (!existsSync(path)) {
        continue
      }

      const raw = readFileSync(path, "utf8")
      applyOpencodeConfig(JSON.parse(raw))
      log("config_loaded", { source: "file", path })
      return true
    } catch (error) {
      log("config_invalid_type", {
        key: "opencode.json",
        expectedType: "valid json config file",
        actualType: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return false
}

export function getApiKeyProviderID(): string | null {
  return settings.apiKeyProvider?.id ?? null
}
