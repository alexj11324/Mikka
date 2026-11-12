'use client'

import useSWR, { unstable_serialize } from 'swr'
import { getReviewSummary } from '@/lib/code-review/client'
import type { ReviewSummary } from '@/lib/code-review/contract'
import { reviewKeys, useReviewLive } from './review-keys'

/** The summary line's data (R0, R0b, R6) for a coding task; null taskId reads nothing. Refreshed by live pushes only. */
export function useReviewSummary(taskId: string | null | undefined) {
  const key = taskId ? reviewKeys.summary(taskId) : null
  const result = useSWR<ReviewSummary | null>(key, ([, id]: readonly [string, string]) => getReviewSummary(id), {
    revalidateOnFocus: false, revalidateOnReconnect: true, shouldRetryOnError: false,
  })
  useReviewLive(taskId ?? null, result.data?.live?.workspaceId, key ? [unstable_serialize(key)] : [])
  return result
}
