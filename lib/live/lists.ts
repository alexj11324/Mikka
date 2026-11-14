import type { PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import type { workspaceDb } from '../workspace-db'
import { afterDatabaseCommit } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'
import { ownerLiveScope } from './owner-scope'

type Database = Pick<PoolClient, 'query'>
export type OwnerListKind = 'thread_list' | 'task_run_list' | 'bot_chat_list' | 'device_list'
export type WorkspaceListKind = 'issue_list' | 'bot_list' | 'group_list' | 'workspace_settings'
type ListKind = OwnerListKind | WorkspaceListKind | 'model_settings'
type Target = { scope: LiveScope; events: LiveInvalidation[] }

const target = (scope: LiveScope, kinds: readonly ListKind[]): Target => ({
  scope, events: [...new Set(kinds)].map(kind => ({ kind, id: scope.workspaceId })),
})

/** A list key contains its already-known scope ID, never the changed entity. */
export async function ownerListTargets(workspaceDatabase: Database, ownerId: string, kinds: readonly OwnerListKind[]): Promise<Target[]> {
  const scope = await ownerLiveScope(workspaceDatabase, ownerId)
  return scope ? [target(scope, kinds)] : []
}

async function workspaceScopes(workspaceDatabase: Database, workspaceId: string, owners: readonly string[] | null = null) {
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT m."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
      WHERE w.id=$1 AND (w.kind='team' OR w."userId"=m."userId")
        AND ($2::text[] IS NULL OR m."userId"=ANY($2::text[]))`, [workspaceId, owners],
  )
  return rows
}

/** Both state and completed reply previews follow the run's persisted owner and tenant.
 * A reply preview changes threads only; it cannot refresh every board card. */
export async function runListTargets(database: Database, workspaceDatabase: Database, runId: string, previewOnly = false) {
  const { rows: [run] } = await database.query<{ userId: string; issueId: string | null }>(
    'SELECT "userId","issueId" FROM agent_runs WHERE id=$1', [runId],
  )
  if (!run) return []
  const { threadLiveReferences } = await import('./panels')
  const [reference] = await threadLiveReferences(database, workspaceDatabase, [runId], run.userId)
  return reference?.workspaceId ? [target({ ownerId: run.userId, workspaceId: reference.workspaceId },
    previewOnly || !run.issueId ? ['thread_list'] : ['thread_list', 'task_run_list'])] : []
}

type IssueScope = { id: string; userId: string; scope: string; workspaceId: string | null }

async function issueListScopes(workspaceDatabase: Database, issue: IssueScope): Promise<LiveScope[]> {
  return issue.workspaceId ? workspaceScopes(workspaceDatabase, issue.workspaceId) : []
}

/** A task invalidates only its immutable tenant's active members. */
export async function issueListTargets(database: Database, workspaceDatabase: Database, issueId: string, titleChanged = false): Promise<Target[]> {
  const { rows: [issue] } = await database.query<IssueScope>(`SELECT id,"userId",scope,"workspaceId" FROM issues WHERE id=$1 AND "ownershipState"='bound'`, [issueId])
  if (!issue) return []
  const scopes = await issueListScopes(workspaceDatabase, issue)
  const targets = scopes.map(scope => target(scope, ['issue_list']))
  if (titleChanged) {
    // These readers resolve task names, but do not display the task body.
    // Ordinary autosaves must not invalidate every member's chat/run summary.
    const { rows: owners } = await database.query<{ userId: string }>('SELECT DISTINCT "userId" FROM agent_runs WHERE "issueId"=$1', [issueId])
    if (issue.workspaceId) targets.push(...(await workspaceScopes(workspaceDatabase, issue.workspaceId, owners.map(owner => owner.userId))).map(scope => target(scope, ['task_run_list'])))
    for (const ownerId of new Set(scopes.map(scope => scope.ownerId))) targets.push(...await ownerListTargets(workspaceDatabase, ownerId, ['bot_chat_list']))
  }
  return mergeTargets(targets)
}

/** Only actual participants receive a private group's list invalidation. A
 * removed participant may receive the same known workspace list key to clear
 * that row; no group ID, new membership or message crosses the channel. */
export async function groupListTargets(database: Database, workspaceDatabase: Database, conversationId: string, removedUserId: string | null = null) {
  const { rows: [group] } = await database.query<{ workspaceId: string }>(
    `SELECT "workspaceId" FROM conversations WHERE id=$1 AND kind='group'`, [conversationId],
  )
  if (!group) return []
  const { rows } = await database.query<{ memberId: string }>(
    `SELECT "memberId" FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user'
      AND ("leftAt" IS NULL OR "memberId"=$2)`, [conversationId, removedUserId],
  )
  return (await workspaceScopes(workspaceDatabase, group.workspaceId, rows.map(row => row.memberId))).map(scope => target(scope, ['group_list']))
}

export async function botListTargets(database: Database, workspaceDatabase: Database, botId: string) {
  const { rows: [bot] } = await database.query<{ ownerId: string; workspaceId: string }>('SELECT "ownerId","workspaceId" FROM bots WHERE id=$1', [botId])
  if (!bot) return []
  const scopes = await workspaceScopes(workspaceDatabase, bot.workspaceId, [bot.ownerId])
  return mergeTargets([
    ...scopes.map(scope => target(scope, ['bot_list', 'thread_list', 'task_run_list'])),
    ...await ownerListTargets(workspaceDatabase, bot.ownerId, ['bot_chat_list']),
  ])
}

export async function workspaceListTargets(workspaceDatabase: Database, workspaceId: string, kinds: readonly WorkspaceListKind[]) {
  return (await workspaceScopes(workspaceDatabase, workspaceId)).map(scope => target(scope, kinds))
}

function mergeTargets(targets: readonly Target[]): Target[] {
  const merged = new Map<string, Target>()
  for (const value of targets) {
    const key = JSON.stringify(value.scope)
    let current = merged.get(key)
    if (!current) { current = { scope: value.scope, events: [] }; merged.set(key, current) }
    for (const event of value.events) if (!current.events.some(existing => existing.kind === event.kind && existing.id === event.id)) current.events.push(event)
  }
  return [...merged.values()]
}

type Resolve = (database: Database, workspaceDatabase: Database) => Promise<Target[]>

/** Register at the real writer. A nested savepoint or held query wrapper does
 * not publish before the outer COMMIT, and deferred reads retain its database. */
async function changed(executor: object, key: string, resolve: Resolve) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive } = await import('./notify')
  afterDatabaseCommit(executor, `list:${key}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = mergeTargets(await resolve(pool, workspacePool))
      await (await import('./publish')).sendLiveTargets(pool, targets)
    })
  }))
}

export async function runListChanged(executor: object, runId: string, previewOnly = false) {
  await changed(executor, `run:${runId}:${previewOnly ? 'reply' : 'state'}`, (db, workspace) => runListTargets(db, workspace, runId, previewOnly))
  // The run's cards in its own bot's chat show its state; a reply preview is not a state change.
  if (!previewOnly) {
    await (await import('./chats')).runBotChatChanged(executor, runId)
    await (await import('./project-map')).projectMapRunChanged(executor, runId)
  }
}
export const issueListChanged = async (executor: object, issueId: string, titleChanged = false) => {
  await changed(executor, `issue:${issueId}:${titleChanged ? 'title' : 'content'}`, (db, workspace) => issueListTargets(db, workspace, issueId, titleChanged))
  await (await import('./project-map')).projectMapIssueChanged(executor, issueId)
}
export const botListChanged = (executor: object, botId: string) => changed(executor, `bot:${botId}`, (db, workspace) => botListTargets(db, workspace, botId))
export const groupListChanged = (executor: object, conversationId: string, removedUserId: string | null = null) => changed(executor, `group:${conversationId}:${removedUserId ?? ''}`, (db, workspace) => groupListTargets(db, workspace, conversationId, removedUserId))
export const groupListReadChanged = (executor: object, conversationId: string, ownerId: string) => changed(executor, `group-read:${conversationId}:${ownerId}`, async (db, workspace) => (await groupListTargets(db, workspace, conversationId)).filter(value => value.scope.ownerId === ownerId))
/** A personal archive interval affects this reader's directories in each active workspace. */
export const archivePreferenceChanged = (executor: object, ownerId: string) => changed(executor, `archive-preference:${ownerId}`, async (_db, workspace) => {
  const { rows } = await workspace.query<LiveScope>(`SELECT m."userId" AS "ownerId", w.id AS "workspaceId"
    FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
    WHERE m."userId"=$1 AND m.status='active' AND (w.kind='team' OR w."userId"=$1)`, [ownerId])
  return rows.map(scope => target(scope, ['thread_list', 'group_list']))
})
/** Only the reader's channel in the selected workspace consumes this receipt. */
export const threadReadChanged = (executor: object, ownerId: string, workspaceId: string) =>
  changed(executor, `thread-read:${workspaceId}:${ownerId}`, async (_db, workspace) =>
    (await workspaceScopes(workspace, workspaceId, [ownerId])).map(scope => target(scope, ['thread_list'])))
export const ownerListChanged = (executor: object, ownerId: string, kinds: readonly OwnerListKind[]) => changed(executor, `owner:${ownerId}:${[...kinds].sort().join(',')}`, (_db, workspace) => ownerListTargets(workspace, ownerId, kinds))
export const workspaceListChanged = (executor: object, workspaceId: string, kinds: readonly WorkspaceListKind[]) => changed(executor, `workspace:${workspaceId}:${[...kinds].sort().join(',')}`, (_db, workspace) => workspaceListTargets(workspace, workspaceId, kinds))

/** Personal prefixes and owner profile labels are resolved while reading the
 * list. Refresh only the owner's actual issue scopes, with no issue IDs on the
 * wire, when that persisted display metadata changes. */
export const ownerIssueListsChanged = (executor: object, ownerId: string) => changed(executor, `owner-issues:${ownerId}`, async (database, workspace) => {
  const { rows: tasks } = await database.query<{ workspaceId: string }>(`SELECT DISTINCT "workspaceId" FROM issues WHERE "userId"=$1 AND "ownershipState"='bound'`, [ownerId])
  const { rows: scopes } = tasks.length ? await workspace.query<LiveScope>(`SELECT DISTINCT m."userId" AS "ownerId",w.id AS "workspaceId"
    FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
    WHERE w.id=ANY($1::uuid[])`, [tasks.map(task => task.workspaceId)]) : { rows: [] }
  const home = await ownerLiveScope(workspace, ownerId)
  return mergeTargets([...scopes, ...(home ? [home] : [])].map(scope => target(scope, ['issue_list'])))
})

/** A profile update can change a member avatar in settings and issue rows.
 * Membership comes from the workspace database; content still needs its own
 * ordinary authorized read after this no-content list invalidation. */
export const ownerProfileListsChanged = (executor: object, ownerId: string) => changed(executor, `owner-profile:${ownerId}`, async (_database, workspace) => {
  const { rows: scopes } = await workspace.query<LiveScope>(`SELECT DISTINCT audience."userId" AS "ownerId",w.id AS "workspaceId"
    FROM mikka_workspaces w JOIN mikka_workspace_members source ON source."workspaceId"=w.id AND source."userId"=$1 AND source.status='active'
    JOIN mikka_workspace_members audience ON audience."workspaceId"=w.id AND audience.status='active'`, [ownerId])
  return mergeTargets(scopes.map(scope => target(scope, ['workspace_settings', 'issue_list'])))
})

/**
 * 模型与订阅 changed for an account: a subscription connected, paused or removed, its allowance or model list read
 * again, its order changed. Only the two settings sections listen (`model_settings`), never the app-wide preloader.
 * The account itself re-reads in every workspace it is an active member of (its subscriptions are its own there);
 * teammates only where it shares them with other members (othersMayUse). No connection, model or quota crosses.
 */
export async function ownerSettingsTargets(database: Database, workspaceDatabase: Database, ownerId: string): Promise<Target[]> {
  const { rows: memberships } = await workspaceDatabase.query<{ workspaceId: string }>(`SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId"=$1 AND status='active'`, [ownerId])
  const { othersMayUse } = await import('../personal-policy')
  const shared: string[] = []
  for (const { workspaceId } of memberships) if (await othersMayUse(database, ownerId, workspaceId)) shared.push(workspaceId)
  const { rows: teammates } = shared.length
    ? await workspaceDatabase.query<LiveScope>(`SELECT "userId" AS "ownerId","workspaceId" FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[]) AND status='active' AND "userId"<>$2`, [shared, ownerId])
    : { rows: [] as LiveScope[] }
  return mergeTargets([...memberships.map(({ workspaceId }) => ({ ownerId, workspaceId })), ...teammates].map(scope => target(scope, ['model_settings'])))
}
/** Best effort: an action that already succeeded never fails on its invalidation (the page's own response updates it). */
export const ownerSettingsChanged = (executor: object, ownerId: string) => changed(executor, `owner-settings:${ownerId}`, (database, workspace) => ownerSettingsTargets(database, workspace, ownerId))
  .catch(() => console.warn('[live] settings invalidation unavailable'))

/** The account's workspace directory and personal issue identifiers are read
 * across selected workspaces. Their transport still uses the actual owned
 * home, and carries only that known list key. */
export const ownerWorkspaceListsChanged = (executor: object, ownerId: string, kinds: readonly ('workspace_settings' | 'issue_list')[]) => changed(executor, `owner-workspaces:${ownerId}:${[...kinds].sort().join(',')}`, async (_db, workspace) => {
  const scope = await ownerLiveScope(workspace, ownerId)
  return scope ? [target(scope, kinds)] : []
})

/** Capture only actual active members through the writer's locked workspace
 * transaction. A removed member may clear this known list after COMMIT; this
 * snapshot never grants a ticket or authorizes a subsequent content read. */
export async function workspaceListScopesBeforeChange(executor: Pick<typeof workspaceDb, 'execute'>, workspaceId: string): Promise<LiveScope[]> {
  if (!liveGatewayConfig(process.env)) return []
  const { rows } = await executor.execute<LiveScope>(sql`SELECT m."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
    WHERE w.id=${workspaceId} AND (w.kind='team' OR w."userId"=m."userId")`)
  return rows
}

/** Membership or deletion clears old workspace lists, then refreshes each
 * affected account's workspace directory at its still-authorized real home. */
export const workspaceListScopeChanged = (executor: object, workspaceId: string, previous: readonly LiveScope[]) => changed(executor, `workspace-scope:${workspaceId}`, async (_db, workspace) => {
  const current = await workspaceScopes(workspace, workspaceId)
  const scopes = [...previous.filter(scope => scope.workspaceId === workspaceId), ...current]
  const targets = scopes.map(scope => target(scope, ['workspace_settings', 'issue_list', 'bot_list', 'group_list']))
  for (const ownerId of new Set(scopes.map(scope => scope.ownerId))) {
    const home = await ownerLiveScope(workspace, ownerId)
    if (home) targets.push(target(home, ['workspace_settings', 'bot_chat_list', 'task_run_list', 'thread_list']))
  }
  return mergeTargets(targets)
})

/** Called with the actual locked issue before its scope changes. */
export async function issueListScopesBeforeChange(issue: IssueScope): Promise<LiveScope[]> {
  if (!liveGatewayConfig(process.env)) return []
  try {
    const { workspacePool } = await import('../workspace-db')
    return await issueListScopes(workspacePool, issue)
  } catch {
    console.warn('[live] list scope capture unavailable')
    return []
  }
}

/** Old list and citation previews must clear after the same durable scope
 * transition. They receive only their own known list key, never an issue ID. */
export const issueListScopeChanged = (executor: object, issueId: string, previous: readonly LiveScope[]) => changed(executor, `issue-scope:${issueId}`, async (db, workspace) => {
  const current = await issueListTargets(db, workspace, issueId, true)
  const { rows } = previous.length ? await workspace.query<LiveScope>(
    `SELECT s."ownerId",s."workspaceId" FROM jsonb_to_recordset($1::jsonb) AS s("ownerId" text,"workspaceId" uuid)
      JOIN mikka_workspaces w ON w.id=s."workspaceId"
      JOIN mikka_workspace_members m ON m."workspaceId"=s."workspaceId" AND m."userId"=s."ownerId" AND m.status='active'`, [JSON.stringify(previous)]) : { rows: [] }
  const targets = [...current, ...rows.map(scope => target(scope, ['issue_list']))]
  // A former workspace member may still need to clear their own chat preview.
  // Home membership is checked afresh and no former workspace/entity is sent.
  for (const ownerId of new Set(previous.map(scope => scope.ownerId))) targets.push(...await ownerListTargets(workspace, ownerId, ['bot_chat_list']))
  return mergeTargets(targets)
})
