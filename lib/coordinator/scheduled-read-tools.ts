import type { ToolSet } from 'ai'
import type { AgentToolId } from '@/lib/agent-kit/registry'

/** A scheduled read can use only these existing read capabilities. */
export const SCHEDULE_READ_TOOL_IDS = [
  'web_search', 'list_issues', 'get_issue', 'list_agents', 'list_runs', 'get_run',
  'search_notion_pages', 'read_notion_page_blocks', 'search_slack_messages', 'read_slack_thread',
  'search_gmail', 'read_gmail_message', 'list_calendar_events', 'get_calendar_event',
  'load_skill',
] as const satisfies readonly AgentToolId[]

export function scheduledReadTools(registry: ToolSet, allowed?: readonly string[]): ToolSet {
  const permitted = new Set<string>(SCHEDULE_READ_TOOL_IDS)
  const requested = allowed ? new Set(allowed) : undefined
  return Object.fromEntries(Object.entries(registry).filter(([name]) => permitted.has(name) && (!requested || requested.has(name))))
}
