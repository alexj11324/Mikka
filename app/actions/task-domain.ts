'use server'
import { z } from 'zod'
import { ISSUE_STATUS_CODES } from '@/lib/issue-meta'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { and, desc, eq } from 'drizzle-orm'
import { requireIssueAccess, issueForUser } from '@/lib/issue-access'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { taskPresentation } from '@/lib/task-presentation'
import { ActionFailureError } from '@/lib/action-error'
import { createFactoryStore } from '@/lib/factory/store'
import { readFactoryFlow, type FactoryFlowView } from '@/lib/factory/public-flow'
import { issuesForUser } from '@/lib/issues-for-user'

/** Detail-only read. Lists retain their existing batched readers and live updates. */
export async function getTaskPresentation(issueId: string) {
  const { issue, user } = await requireIssueAccess(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return withTaskWorkspace(user, issue.workspaceId, async () => {
    const metadata = readIssueMetadata(issue.content)
    const [run] = await db.select({ runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome }).from(agentRuns)
      .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.workspaceId, issue.workspaceId!), eq(agentRuns.userId, user.id)))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(1)
    const blockers = metadata.blockedByIds.length ? await issuesForUser({ ...user, [tokenWorkspace]: issue.workspaceId! }, metadata.blockedByIds) : new Map()
    const status = new Map<string, string>([...blockers.values()].map(blocker => [blocker.id, blocker.status]))
    const { rows: [factory] } = await pool.query<{ id: string }>('select id from factory_tasks where "issueId"=$1 and "workspaceId"=$2 and "userId"=$3 order by "updatedAt" desc,id desc limit 1', [issue.id, issue.workspaceId, user.id])
    let flow: FactoryFlowView | null = null
    if (factory) {
      const store = createFactoryStore(pool, (userId, id, tx) => withDatabaseClient(tx, async () => userId === user.id && Boolean(await issueForUser(user, id))))
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        const task = await store.readTaskForUser(client, user.id, factory.id)
        flow = await readFactoryFlow(client, task)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    return taskPresentation({ status: z.enum(ISSUE_STATUS_CODES).parse(issue.status), metadata }, run, flow, id => !['done', 'canceled', 'duplicate'].includes(status.get(id) ?? 'todo'))
  })
}
