import { createHash } from 'node:crypto'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { escapeMarkdown } from './markdown'

/** The only run outcomes a Linear comment may name. Anything else renders the safe fallback. */
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
/** The whole message stays inside this budget whenever the deep link allows it. */
export const RUN_COMMENT_MAX = 400

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

const PREFIX = 'Mikka: '
const SEPARATOR = ' — '
const LINK_LABEL = 'Open in Mikka'
const ELLIPSIS = '…'
/** The closing parenthesis would end the Markdown link early. */
const HTTP_URL = /^https?:\/\/[^\s)]+$/
const EMPTY_SUBJECT: Record<LinearRunCommentLocale, string> = { en: 'your run', 'zh-CN': '你的任务' }
const STATUS_UNAVAILABLE: Record<LinearRunCommentLocale, string> = { en: 'Status unavailable', 'zh-CN': '状态不可用' }

/** Missing or unknown locales read English; Chinese only on an explicit `zh-CN`. */
export function linearRunCommentLocale(value: string | null | undefined): LinearRunCommentLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

/** Task text is display text, never a second line: newlines, controls and bidi/format characters become spaces. */
const oneLine = (value: string) => value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()

/** Collapse whitespace and cap the value without splitting a surrogate pair. */
function truncatePoints(value: string, max: number): string {
  const points = Array.from(value)
  if (max <= 0) return ''
  if (points.length <= max) return points.join('')
  if (max === 1) return ELLIPSIS
  return `${points.slice(0, max - 1).join('')}${ELLIPSIS}`
}

/** Collapse whitespace and cap the title without splitting a surrogate pair. */
export function truncateCommentTitle(title: string, max = RUN_COMMENT_TITLE_MAX): string {
  return truncatePoints(oneLine(title), max)
}

/** Keep the identifier when the title must shrink; the rendered length decides, never a count of code points. */
function fitSubject(identifier: string, title: string, fallback: string, fits: (subject: string) => boolean): string {
  const whole = [identifier, title].filter(Boolean).join(' ') || fallback
  if (fits(whole)) return whole
  if (identifier) {
    for (let take = Array.from(title).length; take > 0; take--) {
      const candidate = [identifier, truncatePoints(title, take)].filter(Boolean).join(' ')
      if (fits(candidate)) return candidate
    }
    if (fits(identifier)) return identifier
  }
  for (let take = Array.from(whole).length - 1; take > 0; take--) {
    const candidate = truncatePoints(whole, take)
    if (fits(candidate)) return candidate
  }
  return ''
}

/**
 * `Mikka: <identifier> <title> — <status>` on one line, then the deep link.
 * Deliberately reads only these five fields: stopReason, error, failureDetails,
 * report, prompt, credentials, paths and names have no way into the body.
 * Unknown statuses render an explicit label instead of a prototype member.
 */
export function linearRunCommentBody(input: LinearRunCommentInput): string {
  const locale = linearRunCommentLocale(input.locale)
  const label = Object.hasOwn(LINEAR_RUN_STATUS_TEXT, input.status)
    ? LINEAR_RUN_STATUS_TEXT[input.status][locale]
    : STATUS_UNAVAILABLE[locale]
  const deepLink = input.deepLink.trim()
  if (!HTTP_URL.test(deepLink)) throw new TypeError('deep link must be an http(s) URL without whitespace or a closing parenthesis')
  const linkLine = `[${LINK_LABEL}](${deepLink})`
  const render = (subject: string) => `${PREFIX}${subject ? `${subject}${SEPARATOR}` : ''}${label}\n${linkLine}`
  // Only the subject is escaped; the fixed Markdown link line stays as built.
  const subject = fitSubject(oneLine(input.identifier), truncateCommentTitle(input.title), EMPTY_SUBJECT[locale],
    candidate => render(escapeMarkdown(candidate)).length <= RUN_COMMENT_MAX)
  return render(escapeMarkdown(subject))
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
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch (error) {
    throw new TypeError('origin must be an http(s) origin', { cause: error })
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search
    || parsed.hash || parsed.username || parsed.password) throw new TypeError('origin must be an http(s) origin')
  const path = withBasePath(workspaceLink({ ...(issueId ? { issue: issueId } : {}), thread: runId }), basePath)
  return `${parsed.origin}${path}`
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
