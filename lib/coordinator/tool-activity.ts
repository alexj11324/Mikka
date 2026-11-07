// How a reply's tool calls read in the chat (R-83): each call's action, the object it acted on and whether it failed,
// and a group's one-line summary. Pure, so the chat, the phone and tests read them the same way.
import type { ChatTool } from '@/lib/coordinator/context'

/**
 * What a call did, for its icon and the group summary. A side effect (it changed something or reached someone) is
 * named first in a summary, so a collapsed group still says what it did (Codex and Cursor fold only reads).
 */
export type ToolAction =
  | 'dispatch' | 'dispatchFactory' | 'wake' | 'messageThread' | 'stopThread' | 'createIssue' | 'updateIssue' | 'sendMail' | 'sendSlack' | 'writeNotion'
  | 'writeCalendar' | 'remember' | 'forget' | 'schedule' | 'factory' | 'github'
  | 'viewIssues' | 'viewThreads' | 'searchWeb' | 'readWeb' | 'readMail' | 'readSlack' | 'readNotion' | 'viewCalendar'
  | 'viewDrive' | 'viewFactory' | 'findRepository' | 'other'

const SIDE_EFFECTS = new Set<ToolAction>(['dispatch', 'dispatchFactory', 'wake', 'messageThread', 'stopThread', 'createIssue', 'updateIssue', 'sendMail', 'sendSlack', 'writeNotion', 'writeCalendar', 'remember', 'forget', 'schedule', 'factory'])

const EXACT: Record<string, ToolAction> = {
  dispatch_run: 'dispatch', dispatch_bot_computer: 'dispatch', dispatch_factory_run: 'dispatch', dispatch_factory_task: 'dispatchFactory', wake_bot_computer: 'wake',
  send_to_run: 'messageThread', stop_run: 'stopThread', stop_factory_task: 'stopThread',
  create_issue: 'createIssue', create_issue_from_request: 'createIssue', intake_factory_request: 'createIssue', update_issue: 'updateIssue',
  send_email: 'sendMail', mailbox_send: 'sendMail', send_slack_message: 'sendSlack', append_notion_paragraph: 'writeNotion',
  create_calendar_event: 'writeCalendar', update_calendar_event: 'writeCalendar', cancel_calendar_event: 'writeCalendar',
  remember: 'remember', forget: 'forget',
  list_issues: 'viewIssues', get_issue: 'viewIssues', list_runs: 'viewThreads', get_run: 'viewThreads',
  web_search: 'searchWeb', read_webpage: 'readWeb', start_web_subagent: 'readWeb',
  search_gmail: 'readMail', read_gmail_message: 'readMail', mailbox_inbox: 'readMail', mailbox_sent: 'readMail',
  search_slack_messages: 'readSlack', read_slack_thread: 'readSlack', search_notion_pages: 'readNotion', read_notion_page_blocks: 'readNotion',
  list_calendar_events: 'viewCalendar', get_calendar_event: 'viewCalendar', list_drive_files: 'viewDrive',
  find_repository: 'findRepository', github_tools: 'github', github_call: 'github',
}

export function toolAction(name: string): ToolAction {
  if (EXACT[name]) return EXACT[name]
  if (name.startsWith('schedule_')) return name === 'schedule_list' || name === 'schedule_history' ? 'other' : 'schedule'
  if (/factory/.test(name)) return /^(get|list)_/.test(name) ? 'viewFactory' : 'factory'
  return 'other'
}

export function isSideEffect(action: ToolAction): boolean {
  return SIDE_EFFECTS.has(action)
}

/** A preview's string field, whole JSON or cut at 200 characters: the first `"key": "value"` found. */
function field(text: string | undefined, keys: readonly string[]): string | null {
  if (!text) return null
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`).exec(text)
    if (match?.[1]) {
      try { return JSON.parse(`"${match[1].replace(/\\$/, '')}"`) as string } catch { return match[1] }
    }
  }
  return null
}

const TARGET_KEYS = ['identifier', 'title', 'name', 'query', 'q', 'subject', 'repository', 'repo', 'url', 'path', 'operation', 'text', 'message', 'instruction'] as const

/** The object a call acted on, from its input: a task's number or title, a search, a repository; null when it names none. */
export function toolTarget(tool: Pick<ChatTool, 'input'>): string | null {
  const value = field(tool.input, TARGET_KEYS)?.replace(/\s+/g, ' ').trim()
  if (!value) return null
  return value.length > 60 ? `${value.slice(0, 59)}…` : value
}

/** The task or thread a call names by id (`runId`, `issueId`), for the chat to show by its name. */
/** The thread a dispatch started, as lib/coordinator/context.ts reads it into the reply's cards; null for any other call. */
export function dispatchedRunId(tool: Pick<ChatTool, 'name' | 'output'>): string | null {
  return tool.name === 'dispatch_run' || tool.name === 'dispatch_bot_computer' ? field(tool.output, ['runId']) : null
}

export function toolObjectId(tool: Pick<ChatTool, 'input'>): string | null {
  return field(tool.input, ['runId', 'issueId', 'threadId', 'taskId'])
}

/**
 * Whether a call failed, and why. A tool that throws is stored as `error`; a tool that answers `{"error": …}` or
 * `{"ok": false}` is stored as done (lib/coordinator/context.ts), but it failed all the same. `reason` is the error
 * code or message when the output names one.
 */
export function toolFailure(tool: Pick<ChatTool, 'state' | 'output'>): { failed: boolean; reason: string | null } {
  const output = tool.output?.trim() ?? ''
  let top: Record<string, unknown> | null = null
  try { const parsed: unknown = JSON.parse(output); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) top = parsed as Record<string, unknown> } catch { /* a preview cut at 200 characters */ }
  // Only the answer's own fields count: an `error` or `ok: false` nested in a listed item is that item's, not the call's.
  const own = (key: string) => top ? (typeof top[key] === 'string' && top[key] ? top[key] as string : null) : field(output.match(new RegExp(`^\\{\\s*"${key}"\\s*:\\s*"[^"]*`))?.[0], [key])
  const reason = own('error') ?? own('code') ?? own('reason') ?? own('message')
  if (tool.state === 'error') return { failed: true, reason: reason ?? (output && !output.startsWith('{') ? output.slice(0, 80) : null) }
  // An empty error (`"error": ""`, null or false) is no error. A preview cut at 200 characters is read only at its start:
  // a cut answer whose `error` or `ok: false` is not its first field is not recognised (known limit; the stored step's
  // own `error` state from spec §6 will cover it).
  const failed = top ? (top.error !== undefined && top.error !== null && top.error !== false && top.error !== '') || top.ok === false
    : /^\{\s*"error"\s*:(?!\s*(?:""|null\b|false\b))/.test(output) || /^\{\s*"ok"\s*:\s*false/.test(output)
  return failed ? { failed: true, reason } : { failed: false, reason: null }
}

/**
 * A call to a tool the bot does not have (the AI SDK's `AI_NoSuchToolError`, #1516): its name is whatever the model
 * made up (「none」), so it is never shown as a tool's name.
 */
export function toolUnknown(tool: Pick<ChatTool, 'state' | 'output'>): boolean {
  return tool.state === 'error' && /^\s*(?:\{\s*"[^"]+"\s*:\s*")?AI_NoSuchToolError\b/.test(tool.output ?? '')
}

export interface ToolSummaryPart { action: ToolAction; count: number }

/**
 * A group's summary: one part per action with how many calls of it succeeded, side effects first, then in the order
 * they happened; how many failed; and the failed calls' tool names, in order, for a group in which nothing succeeded.
 * A failed call never counts in a part, so a summary never says 「派发了 1 个线程」 for a dispatch that failed. A call
 * still running counts in neither.
 */
export function toolSummary(tools: readonly ChatTool[]): { parts: ToolSummaryPart[]; failed: number; failedNames: string[] } {
  const counts = new Map<ToolAction, number>()
  const failedNames: string[] = []
  let failed = 0
  for (const tool of tools) {
    if (tool.state === 'running') continue
    if (toolFailure(tool).failed) {
      failed++
      if (!failedNames.includes(tool.name)) failedNames.push(tool.name)
      continue
    }
    const action = toolAction(tool.name)
    counts.set(action, (counts.get(action) ?? 0) + 1)
  }
  const parts = [...counts].map(([action, count]) => ({ action, count }))
  return { parts: [...parts.filter(part => isSideEffect(part.action)), ...parts.filter(part => !isSideEffect(part.action))], failed, failedNames }
}
