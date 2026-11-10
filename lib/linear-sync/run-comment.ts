import { createHash } from 'node:crypto'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { BASE_PATH, withBasePath } from '@/lib/base-path'

/** The only run outcomes a Linear comment may name. Anything else never reaches a comment. */
export const LINEAR_RUN_STATUS_TEXT = {
  succeeded: { en: 'Done', 'zh-CN': '完成' },
  failed: { en: 'Failed', 'zh-CN': '失败' },
  stopped: { en: 'Stopped', 'zh-CN': '已停止' },
  cancelled: { en: 'Cancelled', 'zh-CN': '已取消' },
} as const

export type LinearRunStatus = keyof typeof LINEAR_RUN_STATUS_TEXT
export type LinearRunCommentLocale = 'en' | 'zh-CN'

/** Longest title in the header, in code points: one line, about 100 Latin characters. */
export const RUN_COMMENT_TITLE_MAX = 100

export type LinearRunCommentInput = {
  /** `taskIdentifiers` output such as `MIK-42`; empty when the task has no identifier. */
  identifier: string
  /** The task title. The caller has already checked `issueForUser`, so it is safe to show. */
  title: string
  status: LinearRunStatus
  /** The link owner's Mikka locale; anything unknown falls back to English, as the copy does. */
  locale?: string | null
  /** Built by `linearRunDeepLink`; only opaque ids, never a title or path. */
  deepLink: string
}

const EMPTY_SUBJECT: Record<LinearRunCommentLocale, string> = { en: 'your run', 'zh-CN': '你的任务' }

/** Missing or unknown locales read English; Chinese only on an explicit `zh-CN`. */
export function linearRunCommentLocale(value: string | null | undefined): LinearRunCommentLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

/** Task text is display text, never a second line: newlines and controls become spaces. */
const oneLine = (value: string) => value.replace(/[\s\p{Cc}]+/gu, ' ').trim()

/** Collapse whitespace and cap the title without splitting a surrogate pair. */
export function truncateCommentTitle(title: string, max = RUN_COMMENT_TITLE_MAX): string {
  const points = Array.from(oneLine(title))
  return points.length <= max ? points.join('') : `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

/**
 * `Mikka: <identifier> <title> — <status>` on one line, then the deep link.
 * Deliberately reads only these five fields: stopReason, error, failureDetails,
 * report, prompt, credentials, paths and names have no way into the body.
 */
export function linearRunCommentBody(input: LinearRunCommentInput): string {
  const copy = LINEAR_RUN_STATUS_TEXT[input.status]
  if (!copy) throw new Error('Unsupported Linear run status')
  const locale = linearRunCommentLocale(input.locale)
  const title = truncateCommentTitle(input.title)
  const subject = [oneLine(input.identifier), title].filter(Boolean).join(' ') || EMPTY_SUBJECT[locale]
  const status = copy[locale]
  return `Mikka: ${subject} — ${status}\n[Open in Mikka](${input.deepLink})`
}

export type LinearRunDeepLinkInput = {
  issueId: string | null
  runId: string
  /** The configured application origin, e.g. `https://app.example.com`; the caller injects it. */
  origin: string
  /** The deployment's path prefix; defaults to the process's configured base path. */
  basePath?: string
}

/** `workspaceLink` names the task and thread; only their opaque ids reach the URL. */
export function linearRunDeepLink({ issueId, runId, origin, basePath = BASE_PATH }: LinearRunDeepLinkInput): string {
  const path = withBasePath(workspaceLink({ ...(issueId ? { issue: issueId } : {}), thread: runId }), basePath)
  return `${origin.replace(/\/+$/, '')}${path}`
}

/**
 * A deterministic Linear comment id for one run: SHA-256 over a fixed prefix,
 * first 16 bytes shaped as an RFC 4122 UUID (version 5 variant). Retries of the
 * same run produce the same id, so Linear's duplicate-id refusal is the
 * idempotency receipt.
 */
export function commentIdForRun(runId: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`mikka-linear-run-comment:${runId}`).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
