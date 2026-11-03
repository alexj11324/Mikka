import 'server-only'
import { createOpenAI } from '@ai-sdk/openai'
import { transcribe } from 'ai'
import { pool } from '@/lib/db'
import type { PoolClient } from 'pg'
import { openApiKeyForChat, usableApiKeys } from '@/lib/model-api-keys'
import { ChatFileError } from './extract'

/** Transcription uses an already-authorized OpenAI key; never substitutes Mikka's paid model or a different account. */
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
  const provider = createOpenAI({ apiKey: credential.apiKey, baseURL: credential.baseUrl })
  try {
    const result = await transcribe({
      model: provider.transcription(model),
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
