import { api, ApiError } from '@/lib/api'
import type { ReviewCheck, ReviewFileRead, ReviewRead } from './contract'
import { sendBody, type Batch } from './review'

/**
 * The review's server calls, in one place, on the shared routes of lib/code-review/client.ts (#1741):
 * /api/tasks/:taskId/review*, the same shapes the web reads. The phone's bearer is accepted there like on the other
 * shared routes.
 */
const task = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/review`
export const reviewPath = task
export const checksPath = (taskId: string) => `${task(taskId)}/checks`
export const filePath = (taskId: string, path: string) => `${task(taskId)}/file?path=${encodeURIComponent(path)}`

export const readReview = (taskId: string) => api<ReviewRead>(reviewPath(taskId))
export const readChecks = (taskId: string) => api<ReviewCheck[]>(checksPath(taskId))
export const readFile = (taskId: string, path: string) => api<ReviewFileRead>(filePath(taskId, path))

export type ActionResult = { kind: 'done' } | { kind: 'needs_confirm' } | { kind: 'denied'; reason: string }

/** 403 { error: reason } becomes a denial with the contract's reason code (R11); 409 needs_confirm asks first (R7). */
function outcome(error: unknown): ActionResult {
  if (error instanceof ApiError && error.status === 409 && error.code === 'needs_confirm') return { kind: 'needs_confirm' }
  if (error instanceof ApiError && error.status === 403) return { kind: 'denied', reason: error.code }
  throw error
}

/** 发给 Agent: the batch as one message in the task's conversation, request-changes on the PR, the next attempt. */
export async function sendToAgent(taskId: string, batch: Batch, idempotencyKey: string): Promise<ActionResult> {
  try {
    await api(`${task(taskId)}/send`, { method: 'POST', body: sendBody(batch, idempotencyKey) })
    return { kind: 'done' }
  } catch (error) {
    return outcome(error)
  }
}

/** 批准合并. With a failing check the server asks first; the second call carries the confirmation. */
export async function merge(taskId: string, confirmFailedChecks = false): Promise<ActionResult> {
  try {
    await api(`${task(taskId)}/merge`, { method: 'POST', body: { confirmFailedChecks } })
    return { kind: 'done' }
  } catch (error) {
    return outcome(error)
  }
}
