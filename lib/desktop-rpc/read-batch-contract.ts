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

export type ReadBatchCall = { action: BatchReadAction; args: unknown[] }
export type ReadBatchItem = { ok: true; result: unknown } | { ok: false; status: number; error: { code: string } }
