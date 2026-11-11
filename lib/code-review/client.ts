// The code review adapter (#1722, #1732): the only place that knows the review endpoints. It narrows every
// response to lib/code-review/contract.ts and maps a 403 with a known reason to a typed denial; anything else
// that is not the expected shape throws ReviewRequestError.
import { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import {
  REVIEW_DENIAL_REASONS,
  type MergeResult,
  type ReviewCheck,
  type ReviewDenial,
  type ReviewDiff,
  type ReviewFile,
  type ReviewFileRead,
  type ReviewPreview,
  type ReviewRead,
  type ReviewSubmission,
  type ReviewSummary,
  type ReviewTerminalEvent,
  type ReviewTerminalRefusal,
  type SendToAgentResult,
} from './contract'

const task = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/review`

/** The review endpoints. Proposed; confirm against #1722 before the backend lands. */
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
  /** GET, text/event-stream → `output` { text } … `ended` { exitCode } | 404 (no terminal) | 403 { error: 'not_owner_terminal' } | 409 (reclaimed) */
  terminal: (taskId: string) => `${task(taskId)}/terminal`,
  /** POST { data } → 204 */
  terminalInput: (taskId: string) => `${task(taskId)}/terminal/input`,
  /** GET → { running: true, url } | { running: false } | 404 (no preview: read as not running) */
  preview: (taskId: string) => `${task(taskId)}/preview`,
} as const

/** A review response that was not what the contract says: a failed request, or a body of the wrong shape. */
export class ReviewRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown, options?: ErrorOptions) {
    super(`Review request failed: HTTP ${status}`, options)
    this.name = 'ReviewRequestError'
  }
}

const count = z.number().int().nonnegative()
const reason = z.enum(REVIEW_DENIAL_REASONS)

const summarySchema = z.object({
  taskId: z.string().min(1),
  pr: z.object({ number: z.number().int().positive(), state: z.enum(['open', 'changes_requested', 'approved', 'merged', 'closed']), url: z.string().url() }).nullable(),
  files: count,
  additions: count,
  deletions: count,
  checks: z.object({ failed: count, passed: count, pending: count }),
  running: z.boolean(),
  branch: z.string().min(1).optional(),
  permissions: z.object({
    canMerge: z.boolean(),
    canSend: z.boolean(),
    canTerminal: z.boolean(),
    reasons: z.object({ merge: reason.optional(), send: reason.optional(), terminal: reason.optional() }).default({}),
  }),
  live: z.object({ workspaceId: z.string().min(1) }).optional(),
}) satisfies z.ZodType<ReviewSummary>

const fileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: count,
  deletions: count,
  viewed: z.boolean().optional(),
  patch: z.string().nullable(),
  tooLarge: z.boolean().optional(),
  comments: count.default(0),
}) satisfies z.ZodType<ReviewFile>
const sentCommentSchema = z.object({ id: z.string().min(1), path: z.string().min(1), line: z.number().int().positive(), side: z.enum(['old', 'new']), body: z.string(), author: z.string(), sentAt: z.string().min(1) })
const fileReadSchema = z.object({ file: fileSchema, comments: z.array(sentCommentSchema).default([]) }) satisfies z.ZodType<ReviewFileRead>

const diffSchema = z.object({
  source: z.object({ kind: z.enum(['machine', 'checkpoint', 'pr']), at: z.string().min(1), reclaimed: z.boolean() }),
  live: z.boolean(),
  base: z.string(),
  head: z.string(),
  files: z.array(fileSchema),
  empty: z.boolean(),
  nextCursor: z.string().min(1).optional(),
}) satisfies z.ZodType<ReviewDiff>

const readSchema = z.object({ summary: summarySchema, diff: diffSchema }) satisfies z.ZodType<ReviewRead>
const checksSchema = z.array(z.object({ id: z.string().min(1), name: z.string().min(1), status: z.enum(['failed', 'passed', 'pending']), logExcerpt: z.string().optional() })) satisfies z.ZodType<ReviewCheck[]>
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
export async function getReviewSummary(taskId: string): Promise<ReviewSummary> {
  return parse(summarySchema, await request(REVIEW_ENDPOINTS.summary(taskId)))
}

/** The review page: the summary and the whole PR's diff, a page of files at a time; `commit` is 按提交筛选. */
export async function getReviewDiff(taskId: string, options: { cursor?: string; commit?: string } = {}): Promise<ReviewRead> {
  return parse(readSchema, await request(query(REVIEW_ENDPOINTS.review(taskId), { cursor: options.cursor, commit: options.commit })))
}

/** One file's patch, for a file paged out or too large to load with the rest (R12 「按文件加载」). */
export async function getReviewFile(taskId: string, path: string): Promise<ReviewFileRead> {
  return parse(fileReadSchema, await request(query(REVIEW_ENDPOINTS.file(taskId), { path })))
}

/** The checks behind the check summary (R1b). */
export async function getReviewChecks(taskId: string): Promise<ReviewCheck[]> {
  return parse(checksSchema, await request(REVIEW_ENDPOINTS.checks(taskId)))
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

const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), text: z.string() }),
  z.object({ type: z.literal('ended'), exitCode: z.number().int().nullable() }),
]) satisfies z.ZodType<ReviewTerminalEvent>

/** One server-sent event block (`event:` and `data:` lines) as a terminal event; anything else is skipped. */
export function terminalEvent(block: string): ReviewTerminalEvent | null {
  let type = 'message'
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (!data.length) return null
  try {
    const parsed = terminalEventSchema.safeParse({ ...JSON.parse(data.join('\n')), type })
    return parsed.success ? parsed.data : null
  } catch { return null }
}

async function* terminalEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ReviewTerminalEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '')
        const event = terminalEvent(block)
        if (event) yield event
      }
    }
    // A stream that ends without the final blank line still carries its last event (often `ended`).
    buffer += decoder.decode()
    if (buffer.trim()) {
      const event = terminalEvent(buffer)
      if (event) yield event
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Opens the task's terminal (R5): its events as they arrive, or why it did not open. The stream ends when the server
 * closes it; abort `signal` to leave.
 */
export async function openReviewTerminal(taskId: string, signal: AbortSignal): Promise<{ kind: 'open'; events: AsyncGenerator<ReviewTerminalEvent> } | { kind: 'refused'; reason: ReviewTerminalRefusal }> {
  const response = await fetch(withBasePath(REVIEW_ENDPOINTS.terminal(taskId)), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/event-stream' }, signal })
  if (response.status === 404) return { kind: 'refused', reason: 'no_endpoint' }
  if (response.status === 403) return { kind: 'refused', reason: 'denied' }
  if (response.status === 409) return { kind: 'refused', reason: 'reclaimed' }
  if (!response.ok || !response.body) throw new ReviewRequestError(response.status, await response.text().catch(() => null))
  return { kind: 'open', events: terminalEvents(response.body) }
}

/** Types into the task's terminal. */
export async function sendReviewTerminalInput(taskId: string, data: string): Promise<void> {
  const reply = await request(REVIEW_ENDPOINTS.terminalInput(taskId), { method: 'POST', json: { data } })
  if (reply.status < 200 || reply.status >= 300) throw new ReviewRequestError(reply.status, reply.body)
}

const previewSchema = z.union([
  z.object({ running: z.literal(true), url: z.string().url() }),
  z.object({ running: z.literal(false) }),
]) satisfies z.ZodType<ReviewPreview>

/** The task's dev preview (R10a, R10b): its address, or no dev server (also when the server has no preview, 404). */
export async function getReviewPreview(taskId: string): Promise<ReviewPreview> {
  const reply = await request(REVIEW_ENDPOINTS.preview(taskId))
  if (reply.status === 404) return { running: false }
  return parse(previewSchema, reply)
}
