/** Registered capabilities, not grants. Every implementation retains its own host authorization. */
export const COMPUTER_TOOL_IDS = [
  'list_computer_workspaces', 'create_computer_bot', 'list_computer_bots', 'wake_bot_computer',
  'list_bot_subscriptions', 'bind_bot_subscription', 'dispatch_bot_computer',
] as const
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

export const AGENT_TOOL_IDS = [
  'search_notion_pages', 'read_notion_page_blocks', 'search_slack_messages', 'read_slack_thread',
  'search_gmail', 'read_gmail_message', 'list_calendar_events', 'get_calendar_event', 'send_email',
  'create_calendar_event', 'update_calendar_event', 'web_search', 'list_issues', 'get_issue', 'create_issue', 'update_issue',
  'list_agents', 'dispatch_run', 'list_runs', 'get_run', 'send_to_run', 'remember', 'forget',
  'stop_run', 'load_skill', 'record_attention',
  ...FACTORY_TOOL_IDS,
  ...COMPUTER_TOOL_IDS,
  ...MAILBOX_TOOL_IDS,
] as const
export type AgentToolId = typeof AGENT_TOOL_IDS[number]
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
