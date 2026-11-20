import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { assertMvpEnvironment, MVP_SERVICES } from './isolated-env.mjs'
import { installMvpTransport } from './transport.mjs'

assertMvpEnvironment()
// The supported AI SDK provider boundary keeps Mikka's WorkflowAgent and all
// durable/tool execution intact. Never import this preload in application code.
globalThis.AI_SDK_DEFAULT_PROVIDER = createOpenAICompatible({ name: 'litellm', baseURL: `${MVP_SERVICES}/litellm/v1`, apiKey: process.env.MIKKA_LITELLM_MASTER_KEY, includeUsage: true })
installMvpTransport()
