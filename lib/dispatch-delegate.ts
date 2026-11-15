import { and, eq } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { db, withDatabaseClient } from './db'
import { agents, agentRuns, issues } from './db/schema'
import { readIssueMetadata } from './issue-metadata'
import { persistIssueMetadata } from './issue-metadata-store'
import { agentActor } from './activity-actor'
import { resourceActionAllowed, lockResourceAccess } from './resource-access/store'

/** The dispatcher calls this only for the initial owner request, on its APP
 * transaction. The same policy rows are held before the task as in the human
 * property writer. A later replay or automatic stage cannot fill a cleared field. */
export async function admitDispatchDelegate(client: PoolClient, userId: string, issueId: string, source?: { eventId: string; botId: string | null }) {
  return withDatabaseClient(client, async () => {
    if (source) {
      const event = await client.query(`SELECT 1 FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message'
        AND ("issueId" IS NULL OR "issueId"=$3) AND "botId" IS NOT DISTINCT FROM $4::uuid FOR SHARE`,
        [source.eventId,userId,issueId,source.botId])
      if (!event.rowCount) return null
    }
    const [task] = await db.select({ workspaceId: issues.workspaceId }).from(issues)
      .where(and(eq(issues.id,issueId),eq(issues.userId,userId),eq(issues.ownershipState,'bound')))
    if (!task?.workspaceId) return null
    const ref = { kind: 'task' as const, id: issueId, workspaceId: task.workspaceId }
    if (!await resourceActionAllowed(db,userId,ref,'canSteer')) return null
    await lockResourceAccess(db,userId,ref,'canSteer')
    return (runId: string) => withDatabaseClient(client, async () => {
      const [issue] = await db.select().from(issues).where(and(eq(issues.id,issueId),eq(issues.userId,userId),
        eq(issues.workspaceId,ref.workspaceId),eq(issues.ownershipState,'bound'))).for('update')
      if (!issue) return false
      const meta = readIssueMetadata(issue.content)
      if (meta.deletedAt || meta.assignee || meta.delegate || meta.delegateSelection === 'manual') return false
      // Older null delegates may be deliberate clears. Only an absent old
      // property or the new creator's explicit opt-in proves it can be filled.
      const raw = issue.content.attrs?.mikka ?? issue.content.attrs?.orvilo
      if (meta.delegateSelection !== 'dispatch' && raw && Object.hasOwn(raw,'delegate')) return false
      // A Coordinator message may predate task creation. Its committed Factory
      // receipt must bind this exact message, task, workspace and admitted run.
      if (source) {
        const receipt = await client.query(`SELECT 1 FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
          WHERE t."sourceEventId"=$1 AND t."userId"=$2 AND t."issueId"=$3 AND t."workspaceId"=$4 AND a."runId"=$5`,
          [source.eventId,userId,issueId,ref.workspaceId,runId])
        if (!receipt.rowCount) return false
      }
      const [agent] = await db.select({ id: agents.id, name: agents.name }).from(agentRuns)
        .innerJoin(agents,and(eq(agents.id,agentRuns.agentId),eq(agents.userId,userId)))
        .where(and(eq(agentRuns.id,runId),eq(agentRuns.userId,userId),eq(agentRuns.workspaceId,ref.workspaceId),eq(agentRuns.issueId,issueId))).for('share')
      if (!agent) return false
      const saved = await persistIssueMetadata(db, issue, { ...meta, delegateSelection:'dispatch', delegate:{ ...agent,kind:'agent',image:null } }, agentActor(agent.id))
      return Boolean(saved)
    })
  })
}
