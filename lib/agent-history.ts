import type { UIMessageChunk } from 'ai'

export type SavedAgentSession = { id: string; title: string; updatedAt: string }
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
            failure ??= '回复连接提前结束，已有内容已保存，请重试。'
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
        failure ??= '回复或保存连接中断，请刷新后查看已保存内容。'
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
