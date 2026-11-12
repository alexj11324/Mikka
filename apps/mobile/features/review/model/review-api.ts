import { taskReviewRef, readSchema, fileReadSchema, checksSchema, checkObservationSchema, sameReviewReference } from '../../../../../lib/code-review/read-contract'
import { api, ApiError } from '@/lib/api'
import type { ReviewCheck, ReviewFileRead, ReviewRead, ReviewSummary } from './contract'
import { sendBody, type Batch } from './review'

/**
 * The review's server calls, in one place, on the shared routes of lib/code-review/client.ts (#1741):
 * /api/tasks/:taskId/review*, the same shapes the web reads. The phone's bearer is accepted there like on the other
 * shared routes.
 */
type TaskReviewRef = NonNullable<ReviewSummary['reviewRef']>
const task = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/review`
export const reviewPath = task
function withReference(path: string, reference?: TaskReviewRef | null, file?: string) {
  const params = new URLSearchParams()
  if (file !== undefined) params.set('path', file)
  if (reference) { params.set('snapshotId', reference.snapshotId); params.set('sourceVersion', reference.sourceVersion) }
  const query = params.toString()
  return query ? path + '?' + query : path
}
export const checksPath = (taskId: string, reference?: TaskReviewRef | null) => withReference(task(taskId) + '/checks', reference)
export const filePath = (taskId: string, path: string, reference?: TaskReviewRef | null) => withReference(task(taskId) + '/file', reference, path)
export const readReviewPath = async (path: string): Promise<ReviewRead | null> => readSchema.nullable().parse(await api<unknown>(path))

function requestedSource(path: string) {
  const params = new URL(path, 'https://mikka.invalid').searchParams
  return params.has('snapshotId') ? taskReviewRef.parse({ snapshotId: params.get('snapshotId'), sourceVersion: params.get('sourceVersion') }) : null
}
export async function readChecksPath(path: string): Promise<ReviewCheck[]> {
  const ref = requestedSource(path), result = await api<unknown>(path)
  if (!ref) return checksSchema.parse(result)
  const observation = checkObservationSchema.parse(result)
  if (!sameReviewReference(ref, observation.reviewRef)) throw new Error('Review reference changed')
  return observation.checks
}
export async function readFilePath(path: string): Promise<ReviewFileRead> {
  const ref = requestedSource(path), file = fileReadSchema.parse(await api<unknown>(path))
  if (ref && (!sameReviewReference(ref, file.reviewRef) || file.file.path !== new URL(path, 'https://mikka.invalid').searchParams.get('path'))) throw new Error('Review file changed')
  return file
}
export const readReview = (taskId: string) => readReviewPath(reviewPath(taskId))
export const readChecks = (taskId: string) => readChecksPath(checksPath(taskId))
export const readFile = (taskId: string, path: string) => readFilePath(filePath(taskId, path))

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
