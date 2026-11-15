import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { readIssueMetadata } from '../issue-metadata'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** Connection lists are bounded by what one edit can touch; beyond this, panels catch up on their next read. */
const MAX_CONNECTED = 50

/** The tasks a task's metadata names, as its connection list reads them (app/actions/issue-operations.ts). */
export function relationIds(content: unknown): string[] {
  const metadata = readIssueMetadata(content as Parameters<typeof readIssueMetadata>[0])
  return [metadata.parentId, metadata.duplicateOfId, ...metadata.blockedByIds, ...metadata.relatedIds].filter((id): id is string => typeof id === 'string' && LIVE_ID.test(id))
}

/** Who sees an issue's members: the issue body's audience, re-checked when sent. */
export async function issueMemberTargets(database: Database, workspaceDatabase: Database, issueId: string): Promise<Target[]> {
  const { documentLiveTargets } = await import('./panels')
  return (await documentLiveTargets(database, workspaceDatabase, issueId)).map(target => ({ scope: target.scope, events: [{ kind: 'issue_members', id: issueId }] }))
}

/** A task's change shows in its own connection list and in the list of every
 * task connected to it, in either direction. Each list's key goes to that
 * task's own audience; a key carries only the task whose list to re-read. */
export async function issueRelationTargets(database: Database, workspaceDatabase: Database, issueIds: readonly string[]): Promise<Target[]> {
  const ids = [...new Set(issueIds.filter(id => LIVE_ID.test(id)))]
  if (!ids.length) return []
  const { rows } = await database.query<{ id: string; userId: string; content: unknown }>(
    `SELECT id,"userId",jsonb_build_object('attrs',content->'attrs') AS content FROM issues WHERE id=ANY($1::uuid[])`, [ids])
  const owners = [...new Set(rows.map(row => row.userId))]
  const { rows: naming } = owners.length ? await database.query<{ id: string }>(
    `SELECT id FROM issues WHERE "userId"=ANY($1::text[]) AND EXISTS (
       SELECT 1 FROM (VALUES (content->'attrs'->'mikka'),(content->'attrs'->'orvilo')) AS m(metadata)
       WHERE m.metadata->>'parentId'=ANY($2::text[]) OR m.metadata->>'duplicateOfId'=ANY($2::text[])
         OR m.metadata->'blockedByIds' ?| $2::text[] OR m.metadata->'relatedIds' ?| $2::text[])
     LIMIT ${MAX_CONNECTED}`, [owners, ids]) : { rows: [] }
  const affected = [...new Set([...ids, ...rows.flatMap(row => relationIds(row.content)), ...naming.map(row => row.id)])].slice(0, MAX_CONNECTED)
  const { issueAudienceTargets } = await import('./panels')
  return issueAudienceTargets(database, workspaceDatabase, affected, 'issue_relations')
}

async function changed(executor: object, key: string, resolve: (database: Database, workspaceDatabase: Database) => Promise<Target[]>) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `issue-detail:${key}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const sends: Promise<void>[] = []
      // One request carries at most 16 keys (lib/live/events.ts).
      for (const target of await resolve(pool, workspacePool)) for (let start = 0; start < target.events.length; start += 16) {
        sends.push(sendLiveInvalidations(target.scope, target.events.slice(start, start + 16)))
      }
      await Promise.all(sends)
    })
  }))
}

/** A member was added to or removed from the issue. */
export const issueMembersChanged = (executor: object, issueId: string) => changed(executor, `members:${issueId}`, (database, workspace) => issueMemberTargets(database, workspace, issueId))
/** These tasks' relations, title, status, priority or deletion changed. Pass a
 * task an edit disconnected too: after COMMIT its metadata no longer names it. */
export const issueRelationsChanged = (executor: object, issueIds: readonly string[]) => changed(executor, `relations:${[...new Set(issueIds)].sort().join(',')}`, (database, workspace) => issueRelationTargets(database, workspace, issueIds))
