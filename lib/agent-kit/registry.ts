import { PERSONAL_MCP_TOOLS } from '@/lib/plugins/contracts'

/** Registered capabilities, not grants. Every implementation retains its own host authorization. */
export const COMPUTER_TOOL_IDS = [
  'list_computer_workspaces', 'create_computer_bot', 'list_computer_bots', 'wake_bot_computer',
  'list_bot_subscriptions', 'bind_bot_subscription', 'dispatch_bot_computer', 'start_web_subagent',
] as const
export const PERSONAL_WRITE_TOOL_IDS = ['append_notion_paragraph', 'send_slack_message', 'cancel_calendar_event'] as const
export const MAILBOX_TOOL_IDS = ['mailbox_recipients', 'mailbox_send', 'mailbox_inbox', 'mailbox_ack', 'mailbox_sent'] as const

/** Capability identifiers only. These do not authorize Factory operations or Skill adoption. */
export const FACTORY_TOOL_IDS = [
  'list_factory_requests',
  'create_issue_from_request',
  'route_factory_task',
  'get_factory_task',
  'list_factory_questions',
  'get_factory_question',
  'answer_factory_context',
  'escalate_factory_question',
  'answer_factory_question_from_user',
  'resolve_factory_task',
  'stop_factory_task',
  'dispatch_factory_run',
  'select_baseline_skill',
  'select_active_skill',
  'register_skill_candidate',
  'skill_evaluation',
  'dispatch_baseline_rehearsal',
  'record_run_feedback',
  'propose_skill_improvement',
  'get_run_improvements',
  'handoff_skill_improvement',
  'get_skill_improvement_factory',
] as const

export const SCHEDULE_TOOL_IDS = ['schedule_create', 'schedule_list', 'schedule_history', 'schedule_update', 'schedule_pause', 'schedule_resume', 'schedule_cancel'] as const

export const AGENT_TOOL_IDS = [
  ...PERSONAL_MCP_TOOLS,
  'list_drive_files',
  ...SCHEDULE_TOOL_IDS,
  'search_notion_pages', 'read_notion_page_blocks', 'search_slack_messages', 'read_slack_thread',
  'list_app_tools', 'call_app_tool',
  'search_gmail', 'read_gmail_message', 'list_calendar_events', 'get_calendar_event', 'send_email',
  'create_calendar_event', 'update_calendar_event', 'web_search', 'list_issues', 'get_issue', 'create_issue', 'update_issue',
  'list_agents', 'list_factory_agent_profiles', 'find_repository', 'github_tools', 'github_call', 'dispatch_run', 'list_runs', 'get_run', 'send_to_run', 'remember', 'forget',
  'stop_run', 'load_skill', 'read_personal_skill', 'record_attention', 'record_decision',
  ...FACTORY_TOOL_IDS,
  'dispatch_factory_task', 'recover_factory_check', 'intake_factory_request',
  ...COMPUTER_TOOL_IDS,
  ...MAILBOX_TOOL_IDS,
  ...PERSONAL_WRITE_TOOL_IDS,
] as const
export type AgentToolId = typeof AGENT_TOOL_IDS[number]

/** Tools in the built-in definition when stored versions began (#355, 96b3017c,
 * 2026-10-28T00:24:18Z). Every later built-in tool has a PLATFORM_TOOL_ADDED entry. */
export const BASELINE_PLATFORM_TOOL_IDS = [
  'search_notion_pages', 'read_notion_page_blocks', 'search_slack_messages', 'read_slack_thread',
  'search_gmail', 'list_calendar_events', 'get_calendar_event', 'send_email', 'create_calendar_event', 'update_calendar_event',
  'web_search', 'list_issues', 'get_issue', 'list_agents', 'dispatch_run', 'list_runs', 'get_run', 'send_to_run',
  'remember', 'forget', 'stop_run', 'load_skill', 'record_attention',
] as const satisfies readonly AgentToolId[]

/** When each later tool joined the built-in definition (agents/default/agent.json or
 * COMPUTER_TOOL_IDS): the merge commit time, UTC. Add a line with every new built-in
 * tool. A stored owner version created before that time gets the tool at execution;
 * one created after it and lacking the tool had it removed on purpose. */
const PLATFORM_TOOL_ADDITIONS: readonly (readonly [string, readonly AgentToolId[]])[] = [
  ['2026-11-11T04:30:00Z', ['read_personal_skill']], // ALE-75 (#1915)
  ['2026-11-05T01:40:16Z', ['list_factory_agent_profiles']], // #1284
  ['2026-11-04T21:30:00Z', ['record_decision']],
  ['2026-11-03T06:00:00Z', ['dispatch_factory_task', 'recover_factory_check', 'intake_factory_request']],
  ['2026-10-28T02:15:12Z', ['read_gmail_message', ...COMPUTER_TOOL_IDS.filter(id => id !== 'start_web_subagent')]], // b536db95
  ['2026-10-28T11:25:47Z', ['create_issue', 'update_issue']], // bf3ae75c
  ['2026-10-29T05:02:48Z', [...FACTORY_TOOL_IDS, 'start_web_subagent']], // 73c002f5
  ['2026-10-31T00:30:35Z', SCHEDULE_TOOL_IDS], // 11ebb049
  ['2026-10-31T04:34:01Z', [...PERSONAL_MCP_TOOLS, 'list_drive_files']], // a703b0ef
  ['2026-10-31T17:25:08Z', ['list_app_tools', 'call_app_tool']], // 4c2de82f (#662)
  ['2026-11-01T19:31:38Z', MAILBOX_TOOL_IDS], // 310c7e99 (#847)
  ['2026-11-02T15:23:48Z', ['find_repository']], // 92746aa0 (#990)
  ['2026-11-02T18:24:20Z', ['github_tools', 'github_call']], // 5953ef45 (#1037 via #1046)
]
export const PLATFORM_TOOL_ADDED: Readonly<Partial<Record<AgentToolId, string>>> = Object.fromEntries(
  PLATFORM_TOOL_ADDITIONS.flatMap(([at, ids]) => ids.map(id => [id, at])),
)
export const AGENT_HOOK_IDS = ['audit', 'failure_cases'] as const
export type AgentHookId = typeof AGENT_HOOK_IDS[number]

/** Pure and Workflow-safe. Unknown or unavailable capabilities fail closed. */
export function selectRegisteredTools<T>(registry: Record<string, T>, requested: readonly string[]): Record<string, T> {
  const result: Record<string, T> = Object.create(null)
  for (const id of requested) {
    if (!(AGENT_TOOL_IDS as readonly string[]).includes(id) || !Object.hasOwn(registry, id)) {
      throw new Error(`agentToolUnavailable:${id}`)
    }
    result[id] = registry[id]
  }
  return result
}
