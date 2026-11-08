import { api, ApiError } from '@/lib/api'
import type { Batch, FileDiff, Review } from './review'
import { sendBody } from './review'

/**
 * The review's server calls, in one place. Routes follow the contract proposed for #1722 (the coordinator's comment
 * 6721658406 sets what each must do); when #1722 lands, only this file changes.
 */
export const reviewPath = (taskId: string) => `/api/mobile/tasks/${taskId}/review`
export const filePath = (taskId: string, path: string) => `${reviewPath(taskId)}/file?path=${encodeURIComponent(path)}`

export const readReview = (taskId: string) => api<Review>(reviewPath(taskId))
export const readFile = (taskId: string, path: string) => api<FileDiff>(filePath(taskId, path))

/** 发给 Agent: the batch as one message in the task's conversation, request-changes on the PR, the next attempt. */
export const sendToAgent = (taskId: string, batch: Batch, idempotencyKey: string) =>
  api<{ messageId: string }>(`${reviewPath(taskId)}/send`, { method: 'POST', body: sendBody(batch, idempotencyKey) })

export type MergeResult = { kind: 'merged' } | { kind: 'confirm' } | { kind: 'denied'; code: string }

/** Why a merge was refused, in the person's words (R11; GitHub without the right permission). */
export const MERGE_DENIED: Record<string, string> = {
  notOwner: '只有任务负责人可以合并',
  githubPermission: 'GitHub 权限不足，没能合并',
}
export const deniedReason = (code: string) => MERGE_DENIED[code] ?? '没能合并'

/** 批准合并. With a failing check the server asks first (409 needsConfirmation); the second call carries the confirmation. */
export async function merge(taskId: string, confirmFailedChecks = false): Promise<MergeResult> {
  try {
    await api(`${reviewPath(taskId)}/merge`, { method: 'POST', body: confirmFailedChecks ? { confirmFailedChecks: true } : {} })
    return { kind: 'merged' }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'needsConfirmation') return { kind: 'confirm' }
    if (error instanceof ApiError && error.status === 403) return { kind: 'denied', code: error.code }
    throw error
  }
}
