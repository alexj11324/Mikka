import type { PoolClient } from 'pg'
import { afterCommit, hasCommitEffect } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

type TaskIdentity = { id: string; userId: string; issueId: string }

type Database = Pick<PoolClient, 'query'>

async function activeWorkspace(database: Database, ownerId: string, workspaceId: string) {
  const { rows: [workspace] } = await database.query<{ id: string }>(
    `SELECT w.id FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
      WHERE m."workspaceId"=$1 AND m."userId"=$2 AND m.status='active' AND (w.kind='team' OR w."userId"=$2)`,
    [workspaceId, ownerId],
  )
  return workspace ? { ownerId, workspaceId: workspace.id } : null
}

/** Call only after the Factory list's normal issue authorization succeeded. */
export async function factoryIssueLiveScope(database: Database, workspaceDatabase: Database, issueId: string, ownerId: string) {
  const { rows: [issue] } = await database.query<{ workspaceId: string | null }>('SELECT "workspaceId" FROM issues WHERE id=$1 AND "ownershipState"=\'bound\'', [issueId])
  return issue?.workspaceId ? activeWorkspace(workspaceDatabase, ownerId, issue.workspaceId) : null
}

/** Factory, its task and its Bot stay inside the same immutable tenant. */
export async function factoryLiveScopes(database: Database, workspaceDatabase: Database, taskId: string, ownerId: string | null) {
  const { rows: [source] } = await database.query<{ userId: string; issueId: string; botId: string | null; workspaceId: string | null; botWorkspaceId: string | null }>(
    `SELECT t."userId",t."issueId",t."botId",i."workspaceId",b."workspaceId" AS "botWorkspaceId" FROM factory_tasks t JOIN issues i ON i.id=t."issueId"
      LEFT JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."userId" WHERE t.id=$1 AND i."ownershipState"='bound' AND t."workspaceId"=i."workspaceId" AND ($2::text IS NULL OR t."userId"=$2)`,
    [taskId, ownerId],
  )
  if (!source?.workspaceId || (source.botId && source.botWorkspaceId !== source.workspaceId)) return null
  const issue = await activeWorkspace(workspaceDatabase, source.userId, source.workspaceId)
  return issue ? { task: issue, issue, issueId: source.issueId } : null
}

export async function factoryLiveTargets(database: Database, workspaceDatabase: Database, taskId: string, ownerId: string | null) {
  const scopes = await factoryLiveScopes(database, workspaceDatabase, taskId, ownerId)
  if (!scopes) return []
  const targets: { scope: LiveScope; events: LiveInvalidation[] }[] = [{ scope: scopes.task, events: [{ kind: 'factory_task', id: taskId }] }]
  if (scopes.issue) {
    const events: LiveInvalidation[] = [{ kind: 'factory_issue', id: scopes.issueId }]
    if (scopes.issue.workspaceId === scopes.task.workspaceId) targets[0].events.push(...events)
    else targets.push({ scope: scopes.issue, events })
  }
  return targets
}

async function sender(taskId: string, ownerId: string | null) {
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  return () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    // Keep the request's isolated database and authority; release only its completed transaction.
    await withoutDatabaseClient(async () => {
      const targets = await factoryLiveTargets(pool, workspacePool, taskId, ownerId)
      await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, target.events)))
    })
  })
}

/** Registration adds no SQL or network dependency to a business transaction. */
export async function factoryChanged(tx: PoolClient, task: TaskIdentity) {
  // The Factory watchdog's due time moves with every task write (#1212).
  armDueTimerAfterCommit(tx, 'run-recovery')
  if (!liveGatewayConfig(process.env)) return
  const key = `factory_task:${task.id}`
  if (hasCommitEffect(tx, key)) return
  await (await import('./project-map')).projectMapIssueChanged(tx, task.issueId)
  afterCommit(tx, key, await sender(task.id, task.userId))
}

/** For provider outcomes and verified webhooks whose UPDATE is already autocommitted. */
export async function factoryCommitted(taskId: string) {
  if (!liveGatewayConfig(process.env)) return
  ;(await sender(taskId, null))()
  const { pool } = await import('../db/request-scope')
  await (await import('./project-map')).projectMapTaskChanged(pool, taskId)
}
