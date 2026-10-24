import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import type { UIMessageChunk } from 'ai'

/** `botId` is the bot the chat is with, or null for an older chat with no bot. */
export type SavedAgentSession = { id: string; title: string; updatedAt: string; preview?: string; botId?: string | null }

/**
 * One line of plain text for the conversation list: the first sentence-sized
 * string in the reply (OpenUI Lang keeps prose in quoted arguments), else
 * plain-text replies as they are, else the person's last message.
 */
export function sessionPreview(completion: string | null | undefined, prompt: string | null | undefined): string {
  const reply = completion?.trim() ?? ''
  for (const match of reply.matchAll(/"((?:[^"\\\n]|\\.){4,})"/g)) {
    try {
      const text = (JSON.parse(`"${match[1]}"`) as string).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(text) && !/^[\w-]+$/.test(text)) return text.slice(0, 120)
    } catch { /* not a JSON string literal */ }
  }
  if (reply && !/^\w+\s*=/.test(reply)) return reply.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export type SavedAgentTurn = { id: string; prompt: string; completion: string; status: 'pending' | 'complete' | 'failed' | 'stopped'; error: string | null }
export type AgentHistory = { sessions: SavedAgentSession[]; sessionId: string | null; turns: SavedAgentTurn[] }
export type AgentCheckpoint = Pick<SavedAgentTurn, 'completion' | 'status' | 'error'>

export function persistAgentStream(stream: ReadableStream<UIMessageChunk>, save: (checkpoint: AgentCheckpoint) => Promise<void>, signal?: AbortSignal) {
  const reader = stream.getReader()
  let completion = ''
  let failure: string | null = null
  let finalized = false
  let cancelled = false
  let lastSaved = Date.now()
  let queue = Promise.resolve()
  let saving = false
  let persistenceError: unknown

  function checkpoint(status: AgentCheckpoint['status']) {
    if (finalized) return queue
    if (status !== 'pending') finalized = true
    const value = { completion, status, error: failure }
    queue = queue.then(() => save(value))
    return queue
  }

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        if (persistenceError) throw persistenceError
        const { value, done } = await reader.read()
        if (cancelled) return
        if (done) {
          if (!finalized) {
            failure ??= agentCopy.theResponseEndedEarlySavedContentIs
            await checkpoint(signal?.aborted ? 'stopped' : 'failed')
          }
          controller.close()
          return
        }
        if (value.type === 'text-delta') {
          completion += value.delta
          if (!saving && Date.now() - lastSaved > 3000) {
            saving = true
            lastSaved = Date.now()
            // Persist in order without holding model chunks behind database latency.
            void checkpoint('pending').catch(error => { persistenceError = error }).finally(() => { saving = false })
          }
        }
        if (value.type === 'error') failure = value.errorText
        if (value.type === 'abort') await checkpoint('stopped')
        if (value.type === 'finish') await checkpoint(signal?.aborted ? 'stopped' : failure ? 'failed' : 'complete')
        if (!cancelled) controller.enqueue(value)
      } catch {
        if (cancelled) return
        failure ??= agentCopy.theConnectionWasInterruptedRefreshToSee
        try { await checkpoint(signal?.aborted ? 'stopped' : 'failed') } catch { /* The stream reports the persistence failure below; never report a successful save. */ }
        controller.enqueue({ type: 'error', errorText: failure })
        controller.close()
      }
    },
    async cancel(reason) {
      cancelled = true
      try { await reader.cancel(reason) } finally { await checkpoint('stopped') }
    },
  })
}
