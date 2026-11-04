import type { PoolClient } from 'pg'
import { afterCommit, hasCommitEffect } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'

type TaskIdentity = { id: string; userId: string; issueId: string }

type Database = Pick<PoolClient, 'query'>

async function activeWorkspace(database: Database, ownerId: string, workspaceId: string) {
  const { rows: [workspace] } = await database.query<{ id: string }>(
    `SELECT "workspaceId" AS id FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
    [workspaceId, ownerId],
  )
  return workspace ? { ownerId, workspaceId: workspace.id } : null
}

async function issueScope(workspaceDatabase: Database, issueId: string, ownerId: string, scope: string): Promise<LiveScope | null> {
  const { rows: [workspace] } = await workspaceDatabase.query<{ id: string }>(
    `SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$1 AND m.status='active'
      WHERE w.id=CASE WHEN $2='workspace' THEN
        (SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$3)
        ELSE (SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND kind='personal' LIMIT 1) END`,
    [ownerId, scope, issueId],
  )
  return workspace ? { ownerId, workspaceId: workspace.id } : null
}

/** Call only after the Factory list's normal issue authorization succeeded. */
export async function factoryIssueLiveScope(database: Database, workspaceDatabase: Database, issueId: string, ownerId: string) {
  const { rows: [issue] } = await database.query<{ scope: string }>('SELECT scope FROM issues WHERE id=$1', [issueId])
  return issue ? issueScope(workspaceDatabase, issueId, ownerId, issue.scope) : null
}

/** The persisted Bot scope and the issue's list scope can differ for a personal issue. */
export async function factoryLiveScopes(database: Database, workspaceDatabase: Database, taskId: string, ownerId: string | null) {
  const { rows: [source] } = await database.query<{ userId: string; issueId: string; botId: string | null; workspaceId: string | null; scope: string }>(
    `SELECT t."userId",t."issueId",t."botId",b."workspaceId",i.scope FROM factory_tasks t JOIN issues i ON i.id=t."issueId"
      LEFT JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."userId" WHERE t.id=$1 AND ($2::text IS NULL OR t."userId"=$2)`,
    [taskId, ownerId],
  )
  if (!source || (source.botId && !source.workspaceId)) return null
  const issue = await issueScope(workspaceDatabase, source.issueId, source.userId, source.scope)
  const task = source.botId ? await activeWorkspace(workspaceDatabase, source.userId, source.workspaceId!) : issue
  return task ? { task, issue, issueId: source.issueId } : null
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
  if (!liveGatewayConfig(process.env)) return
  const key = `factory_task:${task.id}`
  if (hasCommitEffect(tx, key)) return
  afterCommit(tx, key, await sender(task.id, task.userId))
}

/** For provider outcomes and verified webhooks whose UPDATE is already autocommitted. */
export async function factoryCommitted(taskId: string) {
  if (!liveGatewayConfig(process.env)) return
  ;(await sender(taskId, null))()
}
