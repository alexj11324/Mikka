/**
 * A coding task's review on iPhone (#1738; decisions/2026-11-08-1230-coding-workspace.md, frames R2a, R2, R3, R3b),
 * as plain data. The server shapes are the proposed #1722 contract; review-api.ts is the only file that calls it.
 */

/** The one-line summary a code task carries on its chat card and under its title. Null for a non-code task. */
export type ReviewSummary = {
  pr: { number: number; state: 'open' | 'merged' | 'closed'; url?: string } | null
  files: number
  additions: number
  deletions: number
  checks: { failed: number; passed: number; pending: number }
  /** The agent is still working; before a PR exists the diff is the machine's, live. */
  running: boolean
}

/** Where the diff was read from: the running machine, or after it was reclaimed the last checkpoint or the PR. */
export type ReviewSource = { kind: 'machine' | 'checkpoint' | 'pr'; at: string; live: boolean }

export type ReviewFile = { path: string; additions: number; deletions: number; comments: number; status: 'added' | 'modified' | 'deleted' | 'renamed'; tooLarge?: boolean }

export type ReviewCheck = { id: string; name: string; conclusion: 'failure' | 'success' | 'pending' | 'skipped'; logExcerpt?: string }

/** What the reader may do: a teammate without permission sees both actions off, each saying why (R11). */
export type ReviewPermissions = { canSend: boolean; canMerge: boolean }

export const CANNOT_SEND = '只有任务负责人可以发给 Agent'
export const CANNOT_MERGE = '只有任务负责人可以合并'

export type Review = { summary: ReviewSummary; source: ReviewSource; files: ReviewFile[]; checks: ReviewCheck[]; permissions: ReviewPermissions }

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }
export type DiffHunk = { header: string; lines: DiffLine[] }
export type SentComment = { id: string; line: number; side: 'new' | 'old'; body: string; author: string; sent: true }
export type FileDiff = { path: string; hunks: DiffHunk[]; comments: SentComment[] }

/** A comment waiting in the batch, on one line of one file. */
export type PendingComment = { id: string; path: string; line: number; side: 'new' | 'old'; body: string; quote: string }

/** The batch 发给 Agent sends: line comments, an optional note and attached failing checks. */
export type Batch = { comments: PendingComment[]; note: string; checks: string[] }

export const EMPTY_BATCH: Batch = { comments: [], note: '', checks: [] }

const plural = (n: number, word: string) => `${n} ${word}`

/**
 * The summary line (R0, R2a): 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」 with a PR, 「3 个文件 +42 −7 · 运行中」 before
 * one. The parts are separate so the row can colour +/− and the check mark.
 */
export function summaryParts(summary: ReviewSummary, short = false) {
  return {
    pr: summary.pr ? `PR #${summary.pr.number}` : null,
    /** The task detail's short form (R2a) leaves out the file count and says 「1 项失败」. */
    files: short && summary.pr ? null : plural(summary.files, '个文件'),
    additions: `+${summary.additions}`,
    deletions: `−${summary.deletions}`,
    status: summary.pr?.state === 'merged' ? '已合并'
      : summary.checks.failed ? `${summary.checks.failed} 项${short ? '' : '检查'}失败`
      : summary.running ? '运行中'
      : summary.checks.pending ? '检查中'
      : summary.checks.passed ? '检查通过' : null,
    failed: !summary.pr || summary.pr.state !== 'merged' ? summary.checks.failed > 0 : false,
  }
}

/** The whole line as one string, for the screen reader. */
export const summaryLabel = (summary: ReviewSummary) => {
  const p = summaryParts(summary)
  return [p.pr, `${p.files} ${p.additions} ${p.deletions}`, p.status].filter(Boolean).join('，')
}

/** The check row at the top of R2: 「1 项检查失败 · 5 项通过」. */
export function checksLine(checks: ReviewSummary['checks']) {
  return [checks.failed ? `${checks.failed} 项检查失败` : null, checks.passed ? `${checks.passed} 项通过` : null, checks.pending ? `${checks.pending} 项进行中` : null]
    .filter(Boolean).join(' · ') || '没有检查'
}

/** The source line under the title when the machine is gone (R12), or null while the machine serves it. */
export function sourceLine(source: ReviewSource, when: (iso: string) => string) {
  if (source.kind === 'machine') return null
  return `机器已回收，显示的是${source.kind === 'checkpoint' ? '最后一次检查点' : ' PR '}的改动 · ${when(source.at)}`
}

/** The floating bar's words: 「2 条评论 · ios-unit 失败」, or 「写修改意见…」 when nothing is in the batch. */
export function batchLine(batch: Batch, checks: ReviewCheck[]) {
  const attached = checks.filter(check => batch.checks.includes(check.id)).map(check => `${check.name} 失败`)
  return [batch.comments.length ? `${batch.comments.length} 条评论` : null, ...attached].filter(Boolean).join(' · ') || null
}

export const batchIsEmpty = (batch: Batch) => !batch.comments.length && !batch.note.trim() && !batch.checks.length

export function addComment(batch: Batch, comment: PendingComment): Batch {
  return { ...batch, comments: [...batch.comments.filter(item => item.id !== comment.id), comment] }
}
export function editComment(batch: Batch, id: string, body: string): Batch {
  return { ...batch, comments: batch.comments.map(item => item.id === id ? { ...item, body } : item) }
}
export function removeComment(batch: Batch, id: string): Batch {
  return { ...batch, comments: batch.comments.filter(item => item.id !== id) }
}
export function toggleCheck(batch: Batch, id: string): Batch {
  return { ...batch, checks: batch.checks.includes(id) ? batch.checks.filter(item => item !== id) : [...batch.checks, id] }
}

/** The request body of 发给 Agent; the same key for the same batch, so a second tap sends nothing twice. */
export function sendBody(batch: Batch, idempotencyKey: string) {
  return {
    idempotencyKey,
    comments: batch.comments.map(({ path, line, side, body }) => ({ path, line, side, body: body.trim() })).filter(item => item.body),
    ...(batch.note.trim() ? { note: batch.note.trim() } : {}),
    checks: batch.checks,
  }
}

/** A line's number as the sheet titles it (「第 22 行」): the new side's, or the old side's for a removed line. */
export const lineNumber = (line: DiffLine) => line.kind === 'del' ? line.old ?? 0 : line.new ?? line.old ?? 0
export const lineSide = (line: DiffLine): 'new' | 'old' => line.kind === 'del' ? 'old' : 'new'
