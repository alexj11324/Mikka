import 'server-only'
import { createLiteLLMTranscriptionModel } from '@/lib/model-gateway/litellm-client'
import { transcribe } from 'ai'
import { pool } from '@/lib/db'
import type { PoolClient } from 'pg'
import { openApiKeyForChat, usableApiKeys } from '@/lib/model-api-keys'
import { ChatFileError } from './extract'

/** Transcription sends an already-authorized OpenAI key through LiteLLM; never substitutes Mikka's paid model or a different account. */
export async function transcribeChatAudio(
  userId: string,
  workspaceId: string,
  audio: Uint8Array,
  database: Pick<PoolClient, 'query'> = pool,
): Promise<string> {
  const keys = await usableApiKeys(database, userId, workspaceId)
  const choice = keys
    .filter((item) => item.provider === 'openai')
    .flatMap((key) =>
      key.models.filter((model) => /transcribe|^whisper/i.test(model)).map((model) => ({ key, model })),
    )
    .sort((a, b) => Number(/mini/i.test(b.model)) - Number(/mini/i.test(a.model)))[0]
  if (!choice) throw new ChatFileError('audioKeyRequired')
  const { key, model } = choice
  const credential = await openApiKeyForChat(database, userId, workspaceId, key.id)
  try {
    const result = await transcribe({
      model: createLiteLLMTranscriptionModel(model, { apiKey: credential.apiKey, baseUrl: credential.baseUrl, provider: 'openai', modelId: model }),
      audio,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(90000),
    })
    if (!result.text.trim()) throw new ChatFileError('unreadable')
    return result.text
  } catch (error) {
    if (error instanceof ChatFileError) throw error
    throw new ChatFileError('unavailable')
  }
}
