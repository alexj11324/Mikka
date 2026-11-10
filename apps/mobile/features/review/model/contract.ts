// A copy of lib/code-review/contract.ts (#1741), the review contract shared by the web, the hosted layer and iOS.
// When #1741 lands this file becomes `export type * from '../../../../../lib/code-review/contract'`.
// The code review contract (#1722 backend, #1732 UI; decision 2026-11-08 「审阅」).
// One set of types for the web, the hosted layer and iOS: every field ties to an
// acceptance line, quoted in its comment. Only lib/code-review/client.ts knows
// the endpoints; the hooks in hooks/code-review/ and the slots read these types.

/** A pull request's review state (R0, R8). `changes_requested` follows 发给 Agent (GitHub request-changes). */
export type ReviewPullRequestState = 'open' | 'changes_requested' | 'approved' | 'merged' | 'closed'

/** Why the server refused an action (R11), and why a permission below is false. */
export type ReviewDenialReason =
  /** 「只有任务负责人可以合并」 */
  | 'not_owner_merge'
  /** 「只有任务负责人可以发给 Agent」 */
  | 'not_owner_send'
  /** 「只有任务负责人可以用终端」 */
  | 'not_owner_terminal'
  /** GitHub refused the merge: "clear failure reason if GitHub permission is insufficient". */
  | 'github_permission'

export const REVIEW_DENIAL_REASONS = ['not_owner_merge', 'not_owner_send', 'not_owner_terminal', 'github_permission'] as const satisfies readonly ReviewDenialReason[]

/** What this viewer may do on the review page; a teammate sees the actions disabled with the reason (R11). */
export type ReviewPermissions = {
  canMerge: boolean
  canSend: boolean
  canTerminal: boolean
  /** Set for each action that is false. */
  reasons: { merge?: ReviewDenialReason; send?: ReviewDenialReason; terminal?: ReviewDenialReason }
}

/**
 * The one summary line (R0, R0b, R6): 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」, or while the agent runs
 * with no PR 「3 个文件 +42 −7 · 运行中」. "PR number + state (nullable), changed file count, +/− lines, checks
 * summary, running flag. Updates via the existing live push, no polling."
 */
export type ReviewSummary = {
  /** The task (issue) id. */
  taskId: string
  /** Null before a PR exists (R6). */
  pr: { number: number; state: ReviewPullRequestState; url: string } | null
  files: number
  additions: number
  deletions: number
  checks: { failed: number; passed: number; pending: number }
  /** The agent is running on the task (R6 「运行中」). */
  running: boolean
  /** Shown in ⋯ and tooltips, never on the bar (R-91). */
  branch?: string
  permissions: ReviewPermissions
  /** The live channel this read belongs to, as other reads carry it; the hooks subscribe to it. */
  live?: { workspaceId: string }
}

/**
 * Where the diff came from (R12): "machine workspace while running; after reclaim, latest checkpoint diff, then
 * PR diff. Always return actual source + time" — 「机器已回收，显示的是最后一次检查点 / PR 的改动」.
 */
export type ReviewDiffSource = {
  kind: 'machine' | 'checkpoint' | 'pr'
  /** ISO time of the source. */
  at: string
  /** The machine was reclaimed, so this is a fallback. */
  reclaimed: boolean
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** One changed file in the middle column, `+N −M`, with 「已看」 (R1). */
export type ReviewFile = {
  path: string
  /** The old path of a renamed file. */
  previousPath?: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  /** Marked as viewed by this viewer. */
  viewed?: boolean
  /** The file's unified diff (lib/thread-changes.ts parses it). Null when paged or too large: fetch it per file (R12 「按文件加载」). */
  patch: string | null
  /** Too large to load with the rest (R12). */
  tooLarge?: boolean
  /** Comments already sent on this file, for the file list (「2 条评论」). Their text comes with the file (ReviewFileRead). */
  comments: number
}

/** The whole PR's final diff, base…head (decision 3); no per-attempt switch. 按提交筛选 passes a commit. */
export type ReviewDiff = {
  source: ReviewDiffSource
  /** Pushed live while the agent runs and no PR exists (R6 「实时」). */
  live: boolean
  base: string
  head: string
  files: ReviewFile[]
  /** "Explicit empty state" (R12 no changes). */
  empty: boolean
  /** More files to page in ("large changes paged per file"). */
  nextCursor?: string
}

/** GET …/review: what the review page opens with. */
export type ReviewRead = { summary: ReviewSummary; diff: ReviewDiff }

/** A comment already sent to the agent, drawn inline under its line (R3, R8). */
export type ReviewSentComment = { id: string; path: string; line: number; side: ReviewCommentSide; body: string; author: string; sentAt: string }

/** GET …/review/file?path=: one file with its patch and the comments already sent on it, per file so a big PR does not send them all up front. */
export type ReviewFileRead = { file: ReviewFile; comments: ReviewSentComment[] }

/** Which side of a diff line a comment is on: the old file (deleted line) or the new one. */
export type ReviewCommentSide = 'old' | 'new'

/** One check in the expanded check summary (R1b). The excerpt carries no secrets. */
export type ReviewCheck = {
  /** Stable id; two checks in different workflows may share a name. 附到评论 uses it. */
  id: string
  name: string
  status: 'failed' | 'passed' | 'pending'
  logExcerpt?: string
}


/** A pending line comment, held on this device until 发给 Agent (编辑 / 删除 on hover). `id` is local. */
export type ReviewComment = { id: string; path: string; line: number; side: ReviewCommentSide; body: string }

/**
 * 发给 Agent, the only submit: "batch of line comments (may be empty) + optional note + attached failing checks.
 * Idempotent (double click doesn't double send)". It becomes 「你：N 条评论」 in the task's conversation.
 */
export type ReviewSubmission = {
  comments: ReviewComment[]
  note?: string
  /** Check ids (ReviewCheck.id) added with 附到评论; a check is never sent alone. */
  attachedChecks: string[]
  /** One per batch; a retry of the same batch reuses it. */
  idempotencyKey: string
}

export type ReviewDenial = { kind: 'denied'; reason: ReviewDenialReason; message: string | null }

/** The batch became a message, and the next attempt started on the same branch. */
export type SendToAgentResult = { kind: 'sent'; messageId: string; attempt: number } | ReviewDenial

/** 批准合并: with failing checks the server asks first (R7 「还有 1 项检查失败，确定合并？」); then R8 已合并. */
export type MergeResult = { kind: 'needs_confirm'; failing: number } | { kind: 'merged' } | ReviewDenial
