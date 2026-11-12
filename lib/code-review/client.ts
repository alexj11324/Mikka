// The code review adapter (#1722, #1732): the only place that knows the review endpoints. It narrows every
// response to lib/code-review/contract.ts and maps a 403 with a known reason to a typed denial; anything else
// that is not the expected shape throws ReviewRequestError.
import { z } from 'zod'
import type { TaskReviewRef } from '@mikka/protocol/coding-workspace-review'
import { count, reason, summarySchema, fileReadSchema, readSchema, checksSchema, checkObservationSchema, sameReviewReference } from './read-contract'
import { withBasePath } from '@/lib/base-path'
import {
  type MergeResult,
  type ReviewCheck,
  type ReviewDenial,
  type ReviewFileRead,
  type ReviewRead,
  type ReviewSubmission,
  type ReviewSummary,
  type SendToAgentResult,
} from './contract'

const task = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/review`

/** Task-scoped reads and actions documented in docs/coding-workspace-task-review-api.md. */
export const REVIEW_ENDPOINTS = {
  /** GET ?cursor=&commit= → { summary, diff } */
  review: task,
  /** GET → summary */
  summary: (taskId: string) => `${task(taskId)}/summary`,
  /** GET ?path= → { file (with patch), comments: sent comments on it } */
  file: (taskId: string) => `${task(taskId)}/file`,
  /** GET → [{ id, name, status, logExcerpt }] */
  checks: (taskId: string) => `${task(taskId)}/checks`,
  /** POST { comments, note?, attachedChecks: check ids, idempotencyKey } → 200 { messageId, attempt } | 403 { error: reason, reason, message? } */
  send: (taskId: string) => `${task(taskId)}/send`,
  /** POST { confirmFailedChecks } → 200 { merged: true } | 409 { error: 'needs_confirm', failing } | 403 { error: reason, reason, message? } */
  merge: (taskId: string) => `${task(taskId)}/merge`,
} as const

/** A review response that was not what the contract says: a failed request, or a body of the wrong shape. */
export class ReviewRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown, options?: ErrorOptions) {
    super(`Review request failed: HTTP ${status}`, options)
    this.name = 'ReviewRequestError'
  }
}

function requireReference(requested: TaskReviewRef, returned: TaskReviewRef | null | undefined, reply: Reply) {
  if (!sameReviewReference(requested, returned))
    throw new ReviewRequestError(reply.status, reply.body, { cause: new Error('Review reference changed') })
}

const sentSchema = z.object({ messageId: z.string().min(1), attempt: z.number().int().positive() })
const mergedSchema = z.object({ merged: z.literal(true) })
// Error bodies carry their code in `error` (both clients read it); a 403 repeats it as `reason`.
const confirmSchema = z.object({ error: z.literal('needs_confirm'), failing: count })
const deniedSchema = z.object({ error: reason, reason: reason.optional(), message: z.string().optional() })

type Reply = { status: number; body: unknown }

async function request(path: string, init?: { method?: 'GET' | 'POST'; json?: unknown }): Promise<Reply> {
  const response = await fetch(withBasePath(path), {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: init?.json === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  return { status: response.status, body }
}

function parse<T>(schema: z.ZodType<T>, reply: Reply): T {
  if (reply.status < 200 || reply.status >= 300) throw new ReviewRequestError(reply.status, reply.body)
  const parsed = schema.safeParse(reply.body)
  if (!parsed.success) throw new ReviewRequestError(reply.status, reply.body, { cause: parsed.error })
  return parsed.data
}

/** A 403 that names a known reason is a denial (R11); any other 403 is an error. */
export function reviewDenial(reply: Reply): ReviewDenial | null {
  if (reply.status !== 403) return null
  const parsed = deniedSchema.safeParse(reply.body)
  return parsed.success ? { kind: 'denied', reason: parsed.data.error, message: parsed.data.message ?? null } : null
}

function query(path: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => !!entry[1]))
  const text = search.toString()
  return text ? `${path}?${text}` : path
}

/** The summary line's data (R0, R0b, R6), with this viewer's permissions. */
export async function getReviewSummary(taskId: string): Promise<ReviewSummary | null> {
  return parse(summarySchema.nullable(), await request(REVIEW_ENDPOINTS.summary(taskId)))
}

/** The review page: the summary and the whole PR's diff, a page of files at a time; `commit` is 按提交筛选. */
export async function getReviewDiff(taskId: string, options: { cursor?: string; commit?: string; reference?: TaskReviewRef } = {}): Promise<ReviewRead | null> {
  const reply = await request(query(REVIEW_ENDPOINTS.review(taskId), { cursor: options.cursor, commit: options.commit, ...options.reference }))
  const read = parse(readSchema.nullable(), reply)
  // A filtered commit gets a new revision. A requested page of the same source must keep its exact identity.
  if (options.reference && !options.commit) requireReference(options.reference, read?.diff.reviewRef, reply)
  return read
}

/** One file's patch, for a file paged out or too large to load with the rest (R12 「按文件加载」). */
export async function getReviewFile(taskId: string, path: string, reference?: TaskReviewRef): Promise<ReviewFileRead> {
  const reply = await request(query(REVIEW_ENDPOINTS.file(taskId), { path, ...reference }))
  const read = parse(fileReadSchema, reply)
  if (reference) {
    requireReference(reference, read.reviewRef, reply)
    if (read.file.path !== path) throw new ReviewRequestError(reply.status, reply.body)
  }
  return read
}

/** The checks behind the check summary (R1b). */
export async function getReviewChecks(taskId: string, reference?: TaskReviewRef): Promise<ReviewCheck[]> {
  const reply = await request(query(REVIEW_ENDPOINTS.checks(taskId), { ...reference }))
  if (!reference) return parse(checksSchema, reply)
  const observation = parse(checkObservationSchema, reply)
  requireReference(reference, observation.reviewRef, reply)
  return observation.checks
}

/** 发给 Agent. Local comment ids stay on this device; the server gets path, line, side and body. */
export async function sendToAgent(taskId: string, submission: ReviewSubmission): Promise<SendToAgentResult> {
  const reply = await request(REVIEW_ENDPOINTS.send(taskId), {
    method: 'POST',
    json: {
      comments: submission.comments.map(({ path, line, side, body }) => ({ path, line, side, body })),
      ...(submission.note?.trim() ? { note: submission.note } : {}),
      attachedChecks: submission.attachedChecks,
      idempotencyKey: submission.idempotencyKey,
    },
  })
  const denied = reviewDenial(reply)
  if (denied) return denied
  const sent = parse(sentSchema, reply)
  return { kind: 'sent', messageId: sent.messageId, attempt: sent.attempt }
}

/** 批准合并. Without `confirm`, failing checks come back as needs_confirm (R7); with it, the merge goes ahead. */
export async function mergeReview(taskId: string, options: { confirm: boolean }): Promise<MergeResult> {
  const reply = await request(REVIEW_ENDPOINTS.merge(taskId), { method: 'POST', json: { confirmFailedChecks: options.confirm } })
  const denied = reviewDenial(reply)
  if (denied) return denied
  if (reply.status === 409) {
    const parsed = confirmSchema.safeParse(reply.body)
    if (!parsed.success) throw new ReviewRequestError(reply.status, reply.body, { cause: parsed.error })
    return { kind: 'needs_confirm', failing: parsed.data.failing }
  }
  parse(mergedSchema, reply)
  return { kind: 'merged' }
}
