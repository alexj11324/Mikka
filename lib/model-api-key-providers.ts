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

import { API_KEY_PRESET_ENDPOINTS } from './model-gateway/provider-config'
export { API_KEY_PRESET_ENDPOINTS } from './model-gateway/provider-config'

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
  /** Request features this provider rejects, turned off (decision 2026-11-15-2000); absent means all on. */
  features?: import('./model-gateway/features').GatewayFeatures
}
