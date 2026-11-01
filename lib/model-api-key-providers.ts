/**
 * 「API 与订阅」: the API key providers a person can add, and the shape the
 * page, the model picker and the run injection share (orchestration.md § 1,
 * § 3, § 6). GPT/OpenAI models run on Codex; every other model, including
 * those reached through an API key or an Anthropic-compatible custom
 * provider, runs on Claude Code.
 */
export const API_KEY_PRESETS = ['anthropic', 'openai', 'deepseek', 'kimi'] as const
export type ApiKeyPreset = (typeof API_KEY_PRESETS)[number]
export type ApiKeyProvider = ApiKeyPreset | 'custom'
export type ApiKeyProtocol = 'anthropic' | 'openai'

interface PresetEndpoint {
  /** What the Agent talks to: ANTHROPIC_BASE_URL for Claude Code, the model provider's base_url for Codex. */
  baseUrl: string
  protocol: ApiKeyProtocol
  /** The read-only list the key is checked against when it is added. */
  modelsUrl: string
  modelsAuth: ApiKeyProtocol
}

export const API_KEY_PRESET_ENDPOINTS: Record<ApiKeyPreset, PresetEndpoint> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000', modelsAuth: 'anthropic' },
  openai: { baseUrl: 'https://api.openai.com/v1', protocol: 'openai', modelsUrl: 'https://api.openai.com/v1/models', modelsAuth: 'openai' },
  // DeepSeek and Kimi answer Claude Code on their Anthropic-compatible endpoints; their model lists are OpenAI-style.
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic', modelsUrl: 'https://api.deepseek.com/models', modelsAuth: 'openai' },
  kimi: { baseUrl: 'https://api.moonshot.cn/anthropic', protocol: 'anthropic', modelsUrl: 'https://api.moonshot.cn/v1/models', modelsAuth: 'openai' },
}

/** The models list a custom provider is checked against, by its protocol. */
export function customModelsUrl(baseUrl: string, protocol: ApiKeyProtocol): string {
  const base = baseUrl.replace(/\/+$/, '')
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`
}

/** The Agent that runs a key's models: Codex for OpenAI-protocol credentials, Claude Code for the rest (§ 3). */
export const apiKeyHarness = (protocol: ApiKeyProtocol) => protocol === 'openai' ? 'codex' as const : 'claude_code' as const

/** One credential row as the page and the model picker read it. Never the key itself. */
export interface ApiKeyView {
  id: string
  provider: ApiKeyProvider
  /** A custom provider's own name; null for the presets. */
  name: string | null
  baseUrl: string | null
  protocol: ApiKeyProtocol
  /** The key's last four characters. */
  last4: string
  models: string[]
}
