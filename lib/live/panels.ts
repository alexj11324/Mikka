import type { PoolClient } from 'pg'
import { afterDatabaseCommit, databaseCommitScope } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'
import { batchStreamInvalidation } from './stream-batch'
import { wakeTokens, wakeWorkflowAfterCommit } from '../workflow-wake'
import { armDueTimerAfterCommit } from '../due-timer'

type Database = Pick<PoolClient, 'query'>
type Source = { id: string; userId: string; issueId: string | null; botId: string | null; scope: string | null; workspaceId: string | null }
export type ThreadLiveReference = { id: string; workspaceId: string | null }

/** Resolve persisted entity scopes in the workspace DB. Its active membership
 * check is the ticket's check; never infer a scope from the page's selection. */
async function sourceScopes(workspaceDatabase: Database, sources: Source[]): Promise<Map<string, LiveScope>> {
  if (!sources.length) return new Map()
  const { rows } = await workspaceDatabase.query<{ id: string; ownerId: string; workspaceId: string }>(
    `SELECT s.id,s."userId" AS "ownerId",w.id AS "workspaceId"
     FROM jsonb_to_recordset($1::jsonb) AS s(id uuid,"userId" text,"issueId" uuid,"botId" uuid,scope text,"workspaceId" uuid)
     JOIN mikka_workspaces w ON w.id=s."workspaceId"
     JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=s."userId" AND m.status='active'
     WHERE w.kind='team' OR w."userId"=s."userId"`,
    [JSON.stringify(sources)],
  )
  return new Map(rows.map(row => [row.id, { ownerId: row.ownerId, workspaceId: row.workspaceId }]))
}

export async function threadLiveReferences(database: Database, workspaceDatabase: Database, runIds: string[], ownerId: string): Promise<ThreadLiveReference[]> {
  if (!runIds.length) return []
  const { rows } = await database.query<Source>(
    `SELECT r.id,r."userId",r."issueId",b.id AS "botId",i.scope,r."workspaceId" FROM agent_runs r
     LEFT JOIN issues i ON i.id=r."issueId"
     LEFT JOIN bots b ON b.id=coalesce(
       (SELECT owned.id FROM computer_run_bindings crb JOIN bots owned ON owned.id=crb."botId" AND owned."ownerId"=crb."ownerId"
         WHERE crb."runId"=r.id AND crb."ownerId"=r."userId"),
       (SELECT owned.id FROM bots owned WHERE owned.id=r."botId" AND owned."ownerId"=r."userId"),
       (SELECT owned.id FROM bot_cloud_runtimes runtime JOIN bots owned ON owned.id=runtime."botId" AND owned."ownerId"=runtime."ownerId"
         WHERE runtime."agentId"=r."agentId" AND runtime."ownerId"=r."userId" LIMIT 1))
     WHERE r.id=ANY($1::uuid[]) AND r."userId"=$2
       AND (r."issueId" IS NULL OR i."ownershipState"='bound')
       AND r."workspaceId" IS NOT NULL
       AND (r."issueId" IS NULL OR i."workspaceId"=r."workspaceId")
       AND (b."workspaceId" IS NULL OR r."workspaceId"=b."workspaceId")
       AND (r."botId" IS NULL OR b.id IS NOT NULL)`, [runIds, ownerId],
  )
  const scopes = await sourceScopes(workspaceDatabase, rows)
  return runIds.map(id => ({ id, workspaceId: scopes.get(id)?.workspaceId ?? null }))
}

/** Resolve issue ownership in the application DB and its active audience in the workspace DB. */
export async function issueAudienceTargets(database: Database, workspaceDatabase: Database, issueIds: readonly string[],
  kind: 'issue_document' | 'issue_relations' | 'pull_request_status', viewerId: string | null = null) {
  if (!issueIds.length) return []
  const { rows: issues } = await database.query<{ id: string; workspaceId: string }>(
    `SELECT id,"workspaceId" FROM issues WHERE id=ANY($1::uuid[]) AND "ownershipState"='bound' AND "workspaceId" IS NOT NULL
       AND coalesce(content->'attrs'->'mikka',content->'attrs'->'orvilo')->>'deletedAt' IS NULL`, [issueIds],
  )
  const byId = new Map(issues.map(issue => [issue.id, issue.workspaceId]))
  const workspaceEvents = new Map<string, LiveInvalidation[]>()
  for (const id of issueIds) {
    const workspaceId = byId.get(id.toLowerCase())
    if (!workspaceId) continue
    const events = workspaceEvents.get(workspaceId)
    if (events) events.push({ kind, id })
    else workspaceEvents.set(workspaceId, [{ kind, id }])
  }
  const scopes = await documentScopes(workspaceDatabase, [...workspaceEvents.keys()], viewerId)
  return scopes.map(scope => ({ scope, events: [...workspaceEvents.get(scope.workspaceId)!] }))
}

export function documentLiveTargets(database: Database, workspaceDatabase: Database, issueId: string, viewerId: string | null = null) {
  return issueAudienceTargets(database, workspaceDatabase, [issueId], 'issue_document', viewerId)
}

async function documentScopes(workspaceDatabase: Database, workspaceIds: string[], viewerId: string | null = null) {
  if (!workspaceIds.length) return []
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT m."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
     JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
     WHERE w.id=ANY($1::uuid[]) AND (w.kind='team' OR w."userId"=m."userId")
       AND ($2::text IS NULL OR m."userId"=$2)`, [workspaceIds, viewerId],
  )
  return rows
}

/** Called after the action's ordinary task authorization, without sending content. */
export async function documentLiveWorkspace(database: Database, workspaceDatabase: Database, issueId: string, viewerId: string) {
  const targets = await documentLiveTargets(database, workspaceDatabase, issueId, viewerId)
  return targets.find(target => target.scope.ownerId === viewerId)?.scope.workspaceId ?? null
}

export async function runLiveTargets(database: Database, workspaceDatabase: Database, runId: string, kind: 'run' | 'thread') {
  const { rows: [run] } = await database.query<{ userId: string; issueId: string | null; retryOf: string | null; continuesRunId: string | null; origin: string | null }>(
    `SELECT "userId","issueId","retryOf","continuesRunId","questionContinuation"->>'originRunId' AS origin FROM agent_runs WHERE id=$1`, [runId],
  )
  if (!run) return []
  const ids = [runId]
  if (kind === 'run') {
    const parents = [run.retryOf, run.continuesRunId, run.origin].filter((id): id is string => typeof id === 'string' && LIVE_ID.test(id))
    if (parents.length) {
      const { rows } = await database.query<{ id: string }>('SELECT id FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "issueId" IS NOT DISTINCT FROM $3::uuid', [parents, run.userId, run.issueId])
      ids.push(...rows.map(row => row.id))
    }
  }
  const references = await threadLiveReferences(database, workspaceDatabase, [...new Set(ids)], run.userId)
  const targets = new Map<string, { scope: LiveScope; events: LiveInvalidation[] }>()
  for (const reference of references) {
    if (!reference.workspaceId) continue
    let target = targets.get(reference.workspaceId)
    if (!target) {
      target = { scope: { ownerId: run.userId, workspaceId: reference.workspaceId }, events: [] }
      targets.set(reference.workspaceId, target)
    }
    target.events.push({ kind, id: reference.id })
  }
  return [...targets.values()]
}

/** An issue's thread list includes teammates' threads, so a run change goes to
 * every member who can see the issue, by the same rule as its body, re-checked
 * when sent. The key carries the issue ID only. */
export async function issueThreadTargets(database: Database, workspaceDatabase: Database, issueId: string) {
  const targets = await documentLiveTargets(database, workspaceDatabase, issueId)
  return targets.map(target => ({ scope: target.scope, events: [{ kind: 'issue_threads', id: issueId }] as LiveInvalidation[] }))
}

/** A run's panels (its owner) and its issue's thread list (the issue's members), one request per channel. */
export async function runChangeTargets(database: Database, workspaceDatabase: Database, runId: string) {
  const targets = await runLiveTargets(database, workspaceDatabase, runId, 'run')
  const { rows: [run] } = await database.query<{ issueId: string | null }>('SELECT "issueId" FROM agent_runs WHERE id=$1', [runId])
  const merged = new Map(targets.map(target => [JSON.stringify(target.scope), target]))
  if (run?.issueId) for (const target of await issueThreadTargets(database, workspaceDatabase, run.issueId)) {
    const key = JSON.stringify(target.scope)
    const current = merged.get(key)
    if (current) current.events.push(...target.events); else merged.set(key, target)
  }
  return [...merged.values()]
}

async function changed(executor: object, kind: 'issue_document' | 'run' | 'thread', id: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive } = await import('./notify')
  const databaseScope = databaseCommitScope(executor)
  const publish = async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = kind === 'issue_document' ? await documentLiveTargets(pool, workspacePool, id)
        : kind === 'run' ? await runChangeTargets(pool, workspacePool, id)
        : await runLiveTargets(pool, workspacePool, id, kind)
      await (await import('./publish')).sendLiveTargets(pool, targets)
    })
  }
  afterDatabaseCommit(executor, `${kind}:${id}`, () => scheduleLive(() => kind === 'thread'
    ? batchStreamInvalidation(databaseScope, id, publish)
    : publish()))
}

export const documentChanged = (executor: object, issueId: string) => {
  armDueTimerAfterCommit(executor, 'run-recovery')
  return changed(executor, 'issue_document', issueId)
}
/** A semantic run write also wakes the already mounted immediate parent of a new continuation,
 * and its issue's thread list for every member who can see the issue. */
export const runChanged = (executor: object, runId: string) => {
  // A cloud run's thread-machine lifecycle waits on this instead of re-reading every 30 s (#1212).
  wakeWorkflowAfterCommit(executor, wakeTokens.threadMachine(runId))
  armDueTimerAfterCommit(executor, 'run-recovery')
  return changed(executor, 'run', runId)
}
/** Stream chunks use a separate key so one final state change need not wait for the text cadence. */
export const threadChanged = (executor: object, runId: string) => changed(executor, 'thread', runId)

/** Capture only from the writer's locked issue, before its scope changes. An
 * invalidation contains the already-known ID, never the old or new body. */
export async function documentScopesBeforeChange(issue: { id: string; userId: string; scope: string; workspaceId: string | null }): Promise<LiveScope[]> {
  if (!liveGatewayConfig(process.env)) return []
  try {
    const { workspacePool } = await import('../workspace-db')
    return await documentScopes(workspacePool, issue.workspaceId ? [issue.workspaceId] : [])
  } catch {
    console.warn('[live] document scope capture unavailable')
    return []
  }
}

/** Old subscriptions must reauthorize and move to the new canonical channel.
 * Membership is rechecked after COMMIT, including for previously allowed keys. */
export async function documentScopeChanged(executor: object, issueId: string, previous: LiveScope[]) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `issue-scope:${issueId}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const current = await documentLiveTargets(pool, workspacePool, issueId)
      const { rows } = previous.length ? await workspacePool.query<LiveScope>(
        `SELECT s."ownerId",s."workspaceId" FROM jsonb_to_recordset($1::jsonb) AS s("ownerId" text,"workspaceId" uuid)
          JOIN mikka_workspaces w ON w.id=s."workspaceId"
          JOIN mikka_workspace_members m ON m."workspaceId"=s."workspaceId" AND m."userId"=s."ownerId" AND m.status='active'`, [JSON.stringify(previous)]) : { rows: [] }
      const scopes = new Map([...rows, ...current.map(target => target.scope)].map(scope => [JSON.stringify(scope), scope]))
      await Promise.all([...scopes.values()].map(scope => sendLiveInvalidations(scope, [
        { kind: 'issue_document', id: issueId }, { kind: 'factory_issue', id: issueId },
      ])))
    })
  }))
}
