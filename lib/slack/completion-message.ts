// The one Slack line a finished run posts back to its thread. Pure: the
// caller supplies the visible task label, the fixed status and the deep link,
// so prompt, report, error, stop reason and failure details can never reach
// Slack. Only the task label may shrink; the link is never truncated.
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'

/** Slack renders 400 characters comfortably; the link always wins. */
export const SLACK_COMPLETION_MAX = 400

export const SLACK_RUN_STATUSES = ['succeeded', 'failed', 'stopped', 'cancelled'] as const
export type SlackRunStatus = (typeof SLACK_RUN_STATUSES)[number]
export type SlackCompletionLocale = 'en' | 'zh-CN'

const LABELS: Record<SlackCompletionLocale, Record<SlackRunStatus, string>> = {
  en: { succeeded: 'Done', failed: 'Failed', stopped: 'Stopped', cancelled: 'Cancelled' },
  'zh-CN': { succeeded: '完成', failed: '失败', stopped: '已停止', cancelled: '已取消' },
}
const EMPTY_TASK: Record<SlackCompletionLocale, string> = { en: 'your run', 'zh-CN': '你的任务' }
const PREFIX = 'Mikka: '
const SEPARATOR = ' — '
const ELLIPSIS = '…'
const HTTP_URL = /^https?:\/\/\S+$/

/** A person's Mikka locale, falling back to English as the completion copy does. */
export function slackCompletionLocale(value: string | null | undefined): SlackCompletionLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

export function isSlackRunStatus(value: unknown): value is SlackRunStatus {
  return typeof value === 'string' && (SLACK_RUN_STATUSES as readonly string[]).includes(value)
}

/** Task text is display text, never a second line: newlines and controls become spaces. */
function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, ' ').trim()
}

function truncate(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  if (max === 1) return ELLIPSIS
  return `${value.slice(0, max - 1).trimEnd()}${ELLIPSIS}`
}

export interface SlackCompletionInput {
  /** The task identifier, e.g. MIK-42; omitted when the person cannot see the task. */
  identifier?: string | null
  /** The task title, only when the issue is visible to the link owner. */
  title?: string | null
  status: SlackRunStatus
  /** An app-root link, e.g. from slackCompletionDeepLink. */
  deepLink: string
  locale?: string | null
}

/** `Mikka: <identifier> <title> — <status>` plus the link, bounded and one line. */
export function slackCompletionMessage(input: SlackCompletionInput): string {
  if (!isSlackRunStatus(input.status)) throw new TypeError('unknown run status')
  const deepLink = input.deepLink.trim()
  if (!HTTP_URL.test(deepLink)) throw new TypeError('deep link must be an http(s) URL without whitespace')
  const locale = slackCompletionLocale(input.locale)
  const task = [input.identifier, input.title]
    .map((value) => typeof value === 'string' ? oneLine(value) : '')
    .filter(Boolean)
    .join(' ') || EMPTY_TASK[locale]
  const label = LABELS[locale][input.status]
  const head = `${PREFIX}${task}${SEPARATOR}${label}`
  if (`${head}\n${deepLink}`.length <= SLACK_COMPLETION_MAX) return `${head}\n${deepLink}`
  // The link keeps its bytes; only the task label gives way. If even the link
  // fills the budget, drop the label rather than truncate the link.
  const room = SLACK_COMPLETION_MAX - `${PREFIX}${SEPARATOR}${label}\n${deepLink}`.length
  const bounded = truncate(task, room)
  return `${PREFIX}${bounded ? `${bounded}${SEPARATOR}` : ''}${label}\n${deepLink}`
}

export interface SlackDeepLinkInput {
  issue: string
  thread: string
  /** The configured app origin, e.g. appOrigin from lib/mcp/resource.ts. */
  origin: string
  /** The configured base path; defaults to BASE_PATH through withBasePath. */
  basePath?: string
}

/** The app-root task/thread link, with the app origin and base path applied. */
export function slackCompletionDeepLink({ issue, thread, origin, basePath }: SlackDeepLinkInput): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new TypeError('origin must be an http(s) origin')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('origin must be an http(s) origin')
  }
  return `${parsed.origin}${withBasePath(workspaceLink({ issue, thread }), basePath)}`
}
