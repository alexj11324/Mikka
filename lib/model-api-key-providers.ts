/**
 * 「模型与订阅」: the API key providers a person can add, and the shape the
 * page, the model picker and the run injection share (orchestration.md § 1,
 * § 3, § 6). An Agent talks one protocol: Claude Code the Anthropic one, Codex
 * the OpenAI one. A preset provider serves every protocol its official API
 * speaks (DeepSeek and Kimi speak both, so one key runs on both Agents; Alex,
 * 2026-11-02); a custom provider serves the one protocol the person picked.
 */
export const API_KEY_PRESETS = ['anthropic', 'openai', 'deepseek', 'kimi'] as const
export type ApiKeyPreset = (typeof API_KEY_PRESETS)[number]
export type ApiKeyProvider = ApiKeyPreset | 'custom'
export type ApiKeyProtocol = 'anthropic' | 'openai'
export type ApiKeyHarness = 'claude_code' | 'codex'

interface PresetEndpoint {
  /**
   * Per protocol the official API speaks, the base URL its Agent talks to:
   * ANTHROPIC_BASE_URL for Claude Code, the model provider's base_url for
   * Codex (which Mikka runs on the Responses API). Anthropic first.
   */
  endpoints: Partial<Record<ApiKeyProtocol, string>>
  /** The read-only list the key is checked against when it is added. */
  modelsUrl: string
  modelsAuth: ApiKeyProtocol
  /** The OpenAI-compatible chat endpoint a bot chat (Mikka's own harness, R-05) talks to. */
  chatBaseUrl: string
}

export const API_KEY_PRESET_ENDPOINTS: Record<ApiKeyPreset, PresetEndpoint> = {
  anthropic: { endpoints: { anthropic: 'https://api.anthropic.com' }, modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000', modelsAuth: 'anthropic', chatBaseUrl: 'https://api.anthropic.com/v1' },
  openai: { endpoints: { openai: 'https://api.openai.com/v1' }, modelsUrl: 'https://api.openai.com/v1/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.openai.com/v1' },
  // Both formats, from the providers' own docs: api-docs.deepseek.com (base_url OpenAI / Anthropic) and
  // platform.kimi.ai/docs/api/overview (OpenAI Chat Completions and Responses at /v1, Anthropic Messages at /anthropic).
  deepseek: { endpoints: { anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com/v1' }, modelsUrl: 'https://api.deepseek.com/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.deepseek.com/v1' },
  kimi: { endpoints: { anthropic: 'https://api.moonshot.cn/anthropic', openai: 'https://api.moonshot.cn/v1' }, modelsUrl: 'https://api.moonshot.cn/v1/models', modelsAuth: 'openai', chatBaseUrl: 'https://api.moonshot.cn/v1' },
}

/** The models list a custom provider is checked against, by its protocol. */
export function customModelsUrl(baseUrl: string, protocol: ApiKeyProtocol): string {
  const base = baseUrl.replace(/\/+$/, '')
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`
}

/**
 * Where a bot chat reaches a key's models: the preset's OpenAI-compatible
 * endpoint, or a custom provider's base URL when it speaks the OpenAI protocol.
 * An Anthropic-only custom provider serves threads (Claude Code) but not bot chats.
 */
export function apiKeyChatBaseUrl(key: Pick<ApiKeyView, 'provider' | 'baseUrl' | 'protocol'>): string | null {
  if (key.provider !== 'custom') return API_KEY_PRESET_ENDPOINTS[key.provider].chatBaseUrl
  return key.protocol === 'openai' ? key.baseUrl : null
}

/** The Agent that speaks a protocol: Codex the OpenAI one, Claude Code the Anthropic one (§ 3). */
export const protocolHarness = (protocol: ApiKeyProtocol): ApiKeyHarness => protocol === 'openai' ? 'codex' : 'claude_code'

/** The protocols a key serves: every one its preset's API speaks, or the custom provider's one. Anthropic first. */
export function apiKeyProtocols(key: Pick<ApiKeyView, 'provider' | 'protocol'>): ApiKeyProtocol[] {
  if (key.provider === 'custom') return [key.protocol]
  const endpoints = API_KEY_PRESET_ENDPOINTS[key.provider].endpoints
  return (['anthropic', 'openai'] as const).filter(protocol => endpoints[protocol])
}

/** The key fields that decide which Agents it serves. */
export type ApiKeyAgentFields = Pick<ApiKeyView, 'provider' | 'protocol' | 'responsesApi'>

/**
 * The protocols an Agent can run a key on: Codex runs on the Responses API
 * only, so an OpenAI-protocol custom provider without it serves bot chats
 * (Chat Completions) but not Codex.
 */
const agentProtocols = (key: ApiKeyAgentFields) => apiKeyProtocols(key).filter(protocol => protocol !== 'openai' || key.responsesApi)

/** The Agents that can run a key's models (Claude Code first). */
export const apiKeyHarnesses = (key: ApiKeyAgentFields): ApiKeyHarness[] => agentProtocols(key).map(protocolHarness)

/** What one Agent talks to with this key, or null when the key does not serve that Agent. */
export function apiKeyEndpoint(key: ApiKeyAgentFields & Pick<ApiKeyView, 'baseUrl'>, harness: ApiKeyHarness): { protocol: ApiKeyProtocol; baseUrl: string } | null {
  const protocol = agentProtocols(key).find(item => protocolHarness(item) === harness)
  if (!protocol) return null
  const baseUrl = key.provider === 'custom' ? key.baseUrl : API_KEY_PRESET_ENDPOINTS[key.provider].endpoints[protocol]
  return baseUrl ? { protocol, baseUrl } : null
}

/** One credential row as the page and the model picker read it. Never the key itself. */
export interface ApiKeyView {
  id: string
  /** Present for organization-owned connections; secrets remain write-only. */
  ownership?: 'organization'
  organizationId?: string
  connectionKind?: 'api_key' | 'gateway' | 'custom_endpoint'
  revision?: number
  revokedAt?: string | null
  provider: ApiKeyProvider
  /** A custom provider's own name; null for the presets. */
  name: string | null
  baseUrl: string | null
  /** A custom provider's protocol. A preset's is stored but not used: it serves `apiKeyProtocols`. */
  protocol: ApiKeyProtocol
  /** The key's last four characters. */
  last4: string
  /** What the provider's /models last answered; never a list written by Mikka. */
  models: string[]
  /** Why the last 重新获取模型 failed (401/403, or anything else); null after a good answer. */
  modelsError: 'invalid' | 'unavailable' | null
  /** Whether the OpenAI endpoint serves the Responses API, which Codex runs on. Probed for custom providers only; presets serve it. */
  responsesApi: boolean
}
