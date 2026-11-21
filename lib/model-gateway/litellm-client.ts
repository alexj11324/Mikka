import 'server-only'

import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel } from 'ai'
import { gatewayLiteLlm, managedLiteLlmModel } from './config'
import { decodeHostedCallId } from './hosted-call-id.mjs'

type Credential = {
  provider: 'anthropic' | 'openai'
  apiKey: string
  baseUrl: string
  modelId: string
}

export function liteLLMBaseUrl(url = gatewayLiteLlm()?.url): string | undefined {
  return url && (url.endsWith('/v1') ? url : url + '/v1')
}

function connection() {
  const config = gatewayLiteLlm()
  const baseURL = liteLLMBaseUrl(config?.url)
  if (!config || !baseURL) throw new Error('litellm_not_configured')
  return { baseURL, apiKey: config.masterKey }
}

export function liteLLMResponseCost(headers: HeadersInit | undefined): number | null {
  const raw = new Headers(headers).get('x-litellm-response-cost')
  if (raw === null || raw.trim() === '') return null
  return toMicros(Number(raw))
}

function toMicros(dollars: unknown): number | null {
  if (typeof dollars !== 'number' || dollars < 0) return null
  const micros = Math.ceil(dollars * 1_000_000)
  return Number.isSafeInteger(micros) ? micros : null
}

function receipt(headers: HeadersInit | undefined) {
  const generationId = new Headers(headers).get('x-litellm-call-id')
  const costMicros = liteLLMResponseCost(headers)
  return { liteLLM: { ...(generationId && { generationId }), ...(costMicros !== null && { costMicros }) } }
}

export function liteLLMCost(metadata: unknown): number | null {
  const cost = (metadata as ReturnType<typeof receipt> | undefined)?.liteLLM?.costMicros
  return cost ?? null
}

export function liteLLMGenerationId(metadata: unknown): string | undefined {
  return (metadata as ReturnType<typeof receipt> | undefined)?.liteLLM?.generationId ?? undefined
}

function providerFields(credential: Credential) {
  return {
    model: credential.provider + '/' + credential.modelId,
    custom_llm_provider: credential.provider,
    api_base: credential.baseUrl.replace(/\/+$/, ''),
    api_key: credential.apiKey,
    disable_fallbacks: true,
    num_retries: 0,
  }
}

export function createLiteLLMModel(modelId: string, options: { user?: string; credential?: Credential; callId?: string } = {}) {
  if (options.callId !== undefined && !decodeHostedCallId(options.callId)) throw new Error('hosted_call_identity_invalid')
  const config = connection()
  const provider = createOpenAICompatible({
    ...config,
    name: 'litellm',
    includeUsage: true,
    supportsStructuredOutputs: true,
    supportedUrls: () => ({ 'image/*': [/^https?:\/\//] }),
    async fetch(input, init) {
      const headers = new Headers(init?.headers)
      // Auth and routing come from the server, even when an SDK caller supplies headers.
      headers.set('authorization', 'Bearer ' + config.apiKey)
      headers.delete('x-litellm-api-key')
      if (options.callId) headers.set('x-litellm-call-id', options.callId)
      else headers.delete('x-litellm-call-id')
      const fields = options.credential ? providerFields(options.credential) : {}
      const body = JSON.stringify({ ...JSON.parse(String(init?.body)), ...(options.user && { user: options.user }), ...fields })
      // Add the person's key beyond the SDK's request-body recording boundary.
      return fetch(input, { ...init, headers, body, redirect: 'error' })
    },
  })
  return wrapLanguageModel({
    model: provider.chatModel(options.credential ? modelId : managedLiteLlmModel(modelId)),
    middleware: {
      specificationVersion: 'v4',
      async wrapGenerate({ doGenerate }) {
        const result = await doGenerate()
        return { ...result, providerMetadata: { ...result.providerMetadata, ...receipt(result.response?.headers) } }
      },
      transformParams: async ({ type, params }) => type === 'stream' ? { ...params, includeRawChunks: true } : params,
      async wrapStream({ doStream }) {
        const result = await doStream()
        const { liteLLM } = receipt(result.response?.headers)
        let streamCost: number | null = null
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === 'raw') {
                const event = part.rawValue as { usage?: { cost?: unknown } } | null
                streamCost = toMicros(event?.usage?.cost) ?? streamCost
                return
              }
              const costMicros = streamCost ?? (liteLLM.costMicros || undefined)
              controller.enqueue(part.type === 'finish'
                ? { ...part, providerMetadata: { ...part.providerMetadata, liteLLM: { ...liteLLM, costMicros: costMicros ?? null } } }
                : part)
            },
          })),
        }
      },
    },
  })
}

export function createLiteLLMTranscriptionModel(modelId: string, credential: Credential) {
  const config = connection()
  return createOpenAI({
    ...config,
    async fetch(input, init) {
      if (!(init?.body instanceof FormData)) throw new Error('litellm_transcription_body_invalid')
      const { model, api_key, api_base } = providerFields(credential)
      init.body.set('model', model)
      init.body.set('api_key', api_key)
      init.body.set('api_base', api_base)
      const headers = new Headers(init.headers)
      headers.set('x-litellm-num-retries', '0')
      headers.set('authorization', 'Bearer ' + config.apiKey)
      headers.delete('x-litellm-api-key')
      return fetch(input, { ...init, headers, redirect: 'error' })
    },
  }).transcription(modelId)
}
