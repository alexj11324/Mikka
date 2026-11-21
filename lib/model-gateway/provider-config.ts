/** Provider metadata for LiteLLM routing and read-only credential/model discovery.
 * These addresses are never application model egress endpoints. */
import type { ApiKeyPreset, ApiKeyProtocol } from '../model-api-key-providers'

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
