import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from './db'
import { agentRuns } from './db/schema'
import { readCompactRunFailure } from './run-failure-view'
import { taskStateRunColumns } from './task-state-query'
import { withTaskDevicePresence } from './task-state-presence'

/** Callers hold current Workspace membership and supply authorized Task IDs.
 * One latest-row read, with exact actor/tenant scope and no report or prompt. */
export async function readTaskStateRuns(userId: string, workspaceId: string, issueIds: readonly string[]) {
  if (!issueIds.length) return []
  const rows = await db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, ...taskStateRunColumns })
    .from(agentRuns).where(and(inArray(agentRuns.issueId, [...issueIds]), eq(agentRuns.userId, userId), eq(agentRuns.workspaceId, workspaceId)))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id))
  return (await withTaskDevicePresence(rows)).map(row => ({ ...row, failureDetails: readCompactRunFailure(row.failureDetails) }))
}
