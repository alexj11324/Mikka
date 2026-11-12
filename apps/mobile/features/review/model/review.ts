/**
 * A coding task's review on iPhone (#1738; decisions/2026-11-08-1230-coding-workspace.md, frames R2a, R2, R3, R3b),
 * as plain data over the shared contract (contract.ts, a copy of lib/code-review/contract.ts, #1741). review-api.ts is
 * the only file that calls the server.
 */
import type { ReviewCheck, ReviewComment, ReviewCommentSide, ReviewDenialReason, ReviewDiffSource, ReviewSummary } from './contract'

export type { ReviewCheck, ReviewDiff, ReviewFile, ReviewFileRead, ReviewRead, ReviewSentComment, ReviewSummary } from './contract'

/** One line of a parsed patch, with its old and new numbers. */
export type DiffLine = { kind: 'add' | 'del' | 'ctx'; old?: number; new?: number; text: string }
export type DiffHunk = { header: string; lines: DiffLine[] }

/** A comment waiting in the batch; `quote` is the line it is on, shown in R3b and the batch sheet. */
export type PendingComment = ReviewComment & { quote: string }

/** The batch 发给 Agent sends: line comments, an optional note and attached failing checks (their ids). */
export type Batch = { comments: PendingComment[]; note: string; checks: string[] }

export const EMPTY_BATCH: Batch = { comments: [], note: '', checks: [] }

/** R11, in the person's words, from the contract's reason codes. */
export const DENIAL: Record<ReviewDenialReason, string> = {
  not_owner_merge: '只有任务负责人可以合并',
  not_owner_send: '只有任务负责人可以发给 Agent',
  not_owner_terminal: '只有任务负责人可以用终端',
  github_permission: 'GitHub 权限不足，没能合并',
  review_unavailable: '当前审阅操作不可用',
}
export const denial = (reason: string | undefined, fallback: string) => (reason && reason in DENIAL ? DENIAL[reason as ReviewDenialReason] : fallback)
export const CANNOT_SEND = DENIAL.not_owner_send
export const CANNOT_MERGE = DENIAL.not_owner_merge

export const VERSIONED_READ_ONLY = '此版本目前仅支持查看'
export const usesVersionedReview = (summary: ReviewSummary) => summary.reviewRef !== undefined
export const isMerged = (summary: ReviewSummary) => summary.pr?.state === 'merged'

/**
 * The summary line (R0, R2a): 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」 with a PR, 「3 个文件 +42 −7 · 运行中」 before
 * one. The parts are separate so the row can colour +/− and the check mark. `short` is R2a's form under the task
 * title: no file count once there is a PR, and 「1 项失败」.
 */
export function summaryParts(summary: ReviewSummary, short = false) {
  const merged = isMerged(summary)
  return {
    pr: summary.pr ? `PR #${summary.pr.number}` : null,
    files: summary.files === null || (short && summary.pr) ? null : `${summary.files} 个文件`,
    additions: summary.additions === null ? null : `+${summary.additions}`,
    deletions: summary.deletions === null ? null : `−${summary.deletions}`,
    status: merged ? '已合并'
      : summary.checks?.failed ? `${summary.checks.failed} 项${short ? '' : '检查'}失败`
      : summary.running ? '运行中'
      : summary.checks?.pending ? '检查中'
      : summary.checks?.passed ? '检查通过' : null,
    failed: !merged && !!summary.checks?.failed,
  }
}

/** The whole line as one string, for the screen reader. */
export const summaryLabel = (summary: ReviewSummary) => {
  const p = summaryParts(summary)
  return [p.pr, [p.files, p.additions, p.deletions].filter(Boolean).join(' '), p.status].filter(Boolean).join('，')
}

/** The check row at the top of R2: 「1 项检查失败 · 5 项通过」. */
export function checksLine(checks: ReviewSummary['checks']) {
  if (checks === null) return '尚无检查数据'
  return [checks.neutral ? `${checks.neutral} 项中性` : null, checks.failed ? `${checks.failed} 项检查失败` : null, checks.passed ? `${checks.passed} 项通过` : null, checks.pending ? `${checks.pending} 项进行中` : null]
    .filter(Boolean).join(' · ') || '没有检查'
}

/** The source line when the machine was reclaimed (R12), or null while the machine serves the diff. */
export function sourceLine(source: ReviewDiffSource, when: (iso: string) => string) {
  if (!source.reclaimed) return null
  return `机器已回收，显示的是${source.kind === 'pr' ? ' PR ' : source.kind === 'commit' ? '提交' : source.kind === 'machine' ? '工作树' : '最后一次检查点'}的改动 · ${when(source.at)}`
}

/** The floating bar's words: 「2 条评论 · ios-unit 失败」, or null when nothing is in the batch (写修改意见…). */
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

/** The ReviewSubmission 发给 Agent posts; the same key for the same batch, so a second tap sends nothing twice. */
export function sendBody(batch: Batch, idempotencyKey: string) {
  return {
    idempotencyKey,
    comments: batch.comments.map(({ id, path, line, side, body }) => ({ id, path, line, side, body: body.trim() })).filter(item => item.body),
    ...(batch.note.trim() ? { note: batch.note.trim() } : {}),
    attachedChecks: batch.checks,
  }
}

/** A line's number as the sheet titles it (「第 22 行」): the new side's, or the old side's for a removed line. */
export const lineNumber = (line: DiffLine) => line.kind === 'del' ? line.old ?? 0 : line.new ?? line.old ?? 0
export const lineSide = (line: DiffLine): ReviewCommentSide => line.kind === 'del' ? 'old' : 'new'

/** A file's unified diff (the contract's `patch`) as hunks of numbered lines. File headers and "\ No newline" are skipped. */
export function parsePatch(patch: string | null): DiffHunk[] {
  if (!patch) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 0, newLine = 0
  for (const raw of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (head) {
      oldLine = Number(head[1]); newLine = Number(head[2])
      current = { header: raw, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) current.lines.push({ kind: 'add', new: newLine++, text: raw.slice(1) })
    else if (raw.startsWith('-')) current.lines.push({ kind: 'del', old: oldLine++, text: raw.slice(1) })
    else if (raw.startsWith(' ') || raw === '') current.lines.push({ kind: 'ctx', old: oldLine++, new: newLine++, text: raw.slice(1) })
  }
  // A trailing newline in the patch is not a line of the file.
  for (const hunk of hunks) while (hunk.lines.length && hunk.lines.at(-1)!.kind === 'ctx' && hunk.lines.at(-1)!.text === '' && patch.endsWith('\n')) { hunk.lines.pop(); break }
  return hunks
}
