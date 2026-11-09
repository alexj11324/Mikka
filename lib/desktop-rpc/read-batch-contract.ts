/** Only the Native transport coalesces these existing reads. Their original
 * authorization and any ordinary first-use initialization still apply. */
export const READ_BATCH_ACTION = 'desktop.readBatch'
export const MAX_READ_BATCH = 16
export const READ_BATCH_ACTIONS = [
  'issues.syncIssueList',
  'projects.listProjects',
  'teams.listTeams',
  'team-relations.listProjectTeams',
  'task-runs.pollTaskRuns',
  'task-runs.syncThreadList',
  'coordinator.pollBotChatSummaries',
  'bots.pollBots',
  'coordinator.syncCoordinatorChat',
] as const

export type BatchReadAction = typeof READ_BATCH_ACTIONS[number]
const reads: ReadonlySet<string> = new Set(READ_BATCH_ACTIONS)
export function isBatchReadAction(action: unknown): action is BatchReadAction {
  return typeof action === 'string' && reads.has(action)
}

/** Only these existing readers observe an owner-home revision. Entity and
 * selected-team keys still wait for their original reader's authorization. */
const ownerRevisionKinds = {
  'issues.syncIssueList': 'issue_list',
  'task-runs.pollTaskRuns': 'task_run_list',
  'task-runs.syncThreadList': 'thread_list',
  'coordinator.pollBotChatSummaries': 'bot_chat_list',
} as const

export function readBatchOwnerRevisionKinds(actions: readonly BatchReadAction[]) {
  return [...new Set(actions.flatMap(action => Object.hasOwn(ownerRevisionKinds, action)
    ? [ownerRevisionKinds[action as keyof typeof ownerRevisionKinds]] : []))]
}

export type ReadBatchCall = { action: BatchReadAction; args: unknown[] }
export type ReadBatchItem = { ok: true; result: unknown } | { ok: false; status: number; error: { code: string } }
