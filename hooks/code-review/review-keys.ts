'use client'

// The SWR keys of a task's review reads, and the live keys that refresh them (#1722: "updates via the existing
// live push, no polling"). A run change on the task pushes `issue_threads` and a PR or check change pushes
// `pull_request_status`, both keyed by the task id; until #1722 names its own kind, those two refresh the review.
import { useSWRConfig } from 'swr'
import { useLiveKeys } from '@/hooks/use-live-key'

export const reviewKeys = {
  summary: (taskId: string) => ['review-summary', taskId] as const,
  review: (taskId: string, commit: string | null) => ['review', taskId, commit] as const,
  file: (taskId: string, path: string, head: string) => ['review-file', taskId, path, head] as const,
  checks: (taskId: string) => ['review-checks', taskId] as const,
}

const REVIEW_KEY_HEADS = new Set(['review-summary', 'review', 'review-file', 'review-checks'])

/** True for any review read of this task. */
export const isReviewKey = (key: unknown, taskId: string) => Array.isArray(key) && REVIEW_KEY_HEADS.has(key[0]) && key[1] === taskId

/** Subscribes the given keys to the task's live pushes, once a read has named the channel. */
export function useReviewLive(taskId: string | null, workspaceId: string | null | undefined, keys: readonly string[]) {
  const entities = taskId && workspaceId ? [{ kind: 'issue_threads' as const, id: taskId }, { kind: 'pull_request_status' as const, id: taskId }] : []
  useLiveKeys(entities, entities.length ? keys : [], workspaceId ?? null, { minIntervalMs: 2_000 })
}

/** Re-reads every review read of a task, after this viewer acted on it. */
export function useRevalidateReview() {
  const { mutate } = useSWRConfig()
  return (taskId: string) => mutate(key => isReviewKey(key, taskId))
}
