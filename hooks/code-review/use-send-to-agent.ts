'use client'

import { useCallback, useRef, useState } from 'react'
import { sendToAgent } from '@/lib/code-review/client'
import type { ReviewSubmission, SendToAgentResult } from '@/lib/code-review/contract'
import { useRevalidateReview } from './review-keys'

export type ReviewBatch = Omit<ReviewSubmission, 'idempotencyKey'>

const batchText = (batch: ReviewBatch) => JSON.stringify([batch.comments.map(({ path, line, side, body }) => [path, line, side, body]), batch.note?.trim() ?? '', [...batch.attachedChecks].sort()])

/**
 * 发给 Agent (decision 4): sends the batch once. A second click while it is on its way gets the same answer; a
 * retry of the same batch after a failure reuses its idempotency key, so the server never posts it twice. A
 * batch changed after a failure is a new batch with a new key.
 */
export function useSendToAgent(taskId: string | null | undefined) {
  const revalidate = useRevalidateReview()
  const pending = useRef<{ text: string; key: string; request: Promise<SendToAgentResult> | null } | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendToAgentResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const send = useCallback(async (batch: ReviewBatch): Promise<SendToAgentResult> => {
    if (!taskId) throw new Error('useSendToAgent: no task')
    const text = batchText(batch)
    if (pending.current?.text !== text) pending.current = { text, key: crypto.randomUUID(), request: null }
    const current = pending.current
    if (current.request) return current.request
    setSending(true); setError(null)
    current.request = sendToAgent(taskId, { ...batch, idempotencyKey: current.key })
    try {
      const answer = await current.request
      setResult(answer)
      // Sent or refused, the batch is settled: the next one gets a new key.
      if (pending.current === current) pending.current = null
      if (answer.kind === 'sent') void revalidate(taskId)
      return answer
    } catch (failure) {
      // Keep the key for a retry of the same batch; it may have reached the server.
      current.request = null
      setError(failure)
      throw failure
    } finally { setSending(false) }
  }, [taskId, revalidate])
  return { send, sending, result, error }
}
