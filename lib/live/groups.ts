import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/**
 * One group chat's page (its messages, who is answering, its members and the
 * reactions on its messages) changed. Its key carries the group's id, which only
 * its current human members receive, each on their channel for the group's
 * workspace (the same channel their group_list arrives on). A member who left
 * gets nothing: their page reads 404 at its next read. No message crosses.
 */
export async function groupChatTargets(database: Database, workspaceDatabase: Database, conversationId: string): Promise<Target[]> {
  const { rows: [group] } = await database.query<{ workspaceId: string }>(`SELECT "workspaceId" FROM conversations WHERE id=$1 AND kind='group'`, [conversationId])
  if (!group) return []
  const { rows: members } = await database.query<{ memberId: string }>(
    `SELECT "memberId" FROM conversation_members WHERE "conversationId"=$1 AND "memberType"='user' AND "leftAt" IS NULL`, [conversationId])
  if (!members.length) return []
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT m."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
      WHERE w.id=$1 AND m."userId"=ANY($2::text[])`, [group.workspaceId, members.map(member => member.memberId)])
  return rows.map(scope => ({ scope, events: [{ kind: 'group_chat', id: conversationId }] }))
}

/** The group chats that hold these messages (a reaction names a message only). */
async function messageGroups(database: Database, messageIds: readonly string[]) {
  const { rows } = await database.query<{ conversationId: string }>(
    `SELECT DISTINCT "conversationId" FROM conversation_messages WHERE id=ANY($1::uuid[])`, [messageIds])
  return rows.map(row => row.conversationId)
}

/**
 * Register at the real writer: nothing is sent before its COMMIT, a rollback
 * sends nothing, and an autocommitted write sends after it. Sent on its own,
 * never batched with group_list: a gateway that does not know this kind yet
 * refuses only this request (the app keeps its minute fallback for it).
 */
async function changed(executor: object, key: string, resolve: (database: Database, workspaceDatabase: Database) => Promise<Target[]>) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive } = await import('./notify')
  afterDatabaseCommit(executor, `group-chat:${key}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await resolve(pool, workspacePool)
      await (await import('./publish')).sendLiveTargets(pool, targets)
    })
  }))
}

export const groupChatChanged = (executor: object, conversationId: string) =>
  changed(executor, conversationId, (database, workspace) => groupChatTargets(database, workspace, conversationId))

/** A reaction was set or cleared: the group chats holding these messages re-read (a bot chat's are its owner's own). */
export const groupMessagesChanged = (executor: object, messageIds: readonly string[]) =>
  changed(executor, `messages:${[...messageIds].sort().join(',')}`, async (database, workspace) =>
    (await Promise.all((await messageGroups(database, messageIds)).map(id => groupChatTargets(database, workspace, id)))).flat())
