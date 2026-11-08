'use client'

import { useCallback, useRef, useState } from 'react'
import { mergeReview } from '@/lib/code-review/client'
import type { MergeResult } from '@/lib/code-review/contract'
import { useRevalidateReview } from './review-keys'

/**
 * 批准合并 through #1503's acceptance path. `merge()` first; a needs_confirm answer (R7 「还有 N 项检查失败，确定合并？」)
 * is confirmed with `merge({ confirm: true })` (仍然合并). One merge at a time; after a merge the review re-reads (R8).
 */
export function useMergeReview(taskId: string | null | undefined) {
  const revalidate = useRevalidateReview()
  const inFlight = useRef<Promise<MergeResult> | null>(null)
  const [merging, setMerging] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const merge = useCallback(async (options: { confirm?: boolean } = {}): Promise<MergeResult> => {
    if (!taskId) throw new Error('useMergeReview: no task')
    if (inFlight.current) return inFlight.current
    setMerging(true); setError(null)
    const request = inFlight.current = mergeReview(taskId, { confirm: options.confirm ?? false })
    try {
      const answer = await request
      setResult(answer)
      if (answer.kind === 'merged') void revalidate(taskId)
      return answer
    } catch (failure) {
      setError(failure)
      throw failure
    } finally { inFlight.current = null; setMerging(false) }
  }, [taskId, revalidate])
  /** Forgets a needs_confirm or denial, as 取消 does. */
  const reset = useCallback(() => { setResult(null); setError(null) }, [])
  return { merge, merging, result, error, reset }
}
