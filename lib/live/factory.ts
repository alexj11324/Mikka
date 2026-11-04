import type { PoolClient } from 'pg'
import { afterCommit, hasCommitEffect } from '../db/commit-effects'
import { liveGatewayConfig } from './scope'
import type { LiveInvalidation } from './events'

type TaskIdentity = { id: string; userId: string; issueId: string }

export async function factoryLiveTarget(database: Pick<PoolClient, 'query'>, workspaceDatabase: Pick<PoolClient, 'query'>, taskId: string, ownerId: string | null) {
  const { rows: [source] } = await database.query<{ userId: string; issueId: string; botId: string | null; workspaceId: string | null; scope: string }>(
    `SELECT t."userId",t."issueId",t."botId",b."workspaceId",i.scope FROM factory_tasks t JOIN issues i ON i.id=t."issueId"
      LEFT JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."userId" WHERE t.id=$1 AND ($2::text IS NULL OR t."userId"=$2)`,
    [taskId, ownerId],
  )
  if (!source || (source.botId && !source.workspaceId)) return
  const { rows: [workspace] } = await workspaceDatabase.query<{ id: string }>(
    `SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$1 AND m.status='active'
      WHERE w.id=COALESCE($2::uuid,CASE WHEN $3='workspace' THEN
        (SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$4)
        ELSE (SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind='personal' LIMIT 1) END)`,
    [source.userId, source.workspaceId, source.scope, source.issueId],
  )
  if (!workspace) return
  return { scope: { ownerId: source.userId, workspaceId: workspace.id }, events: [
    { kind: 'factory_task', id: taskId },
    { kind: 'thread', id: source.issueId },
  ] satisfies LiveInvalidation[] }
}

async function sender(taskId: string, ownerId: string | null) {
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  return () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    // Keep the request's isolated database and authority; release only its completed transaction.
    await withoutDatabaseClient(async () => {
      const target = await factoryLiveTarget(pool, workspacePool, taskId, ownerId)
      if (target) await sendLiveInvalidations(target.scope, target.events)
    })
  })
}

/** Registration adds no SQL or network dependency to a business transaction. */
export async function factoryChanged(tx: PoolClient, task: TaskIdentity) {
  if (!liveGatewayConfig(process.env)) return
  const key = `factory_task:${task.id}`
  if (hasCommitEffect(tx, key)) return
  afterCommit(tx, key, await sender(task.id, task.userId))
}

/** For the two provider-outcome writers whose UPDATE is already autocommitted. */
export async function factoryCommitted(taskId: string) {
  if (!liveGatewayConfig(process.env)) return
  ;(await sender(taskId, null))()
}
