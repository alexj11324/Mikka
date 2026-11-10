import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { resourceLiveScopes } from './resource-scopes'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** Every recipient needs fresh membership and this Chat's ACL. Private Bot
 * activity cannot reach an administrator or a different tenant's channel. */
export async function botChatTargets(database: Database, workspaceDatabase: Database, ownerId: string, botId: string | null, list = true): Promise<Target[]> {
  if (!botId || !LIVE_ID.test(botId)) return []
  const { rows: [bot] } = await database.query<{ workspaceId: string; chatId: string }>(
    'select "workspaceId",mikka_chat_resource_id("ownerId",id) as "chatId" from bots where id=$1 and "ownerId"=$2', [botId,ownerId])
  if (!bot) return []
  const scopes = await resourceLiveScopes(database,workspaceDatabase,'chat',bot.chatId,bot.workspaceId)
  return scopes.map(scope => ({ scope, events: [
    ...(list ? [{ kind: 'bot_chat_list' as const, id: scope.workspaceId }] : []),
    { kind: 'bot_chat' as const, id: botId },
  ] }))
}

/** A run's state shows on its cards in its own bot's chat, for the run's owner only. */
export async function runBotChatTargets(database: Database, workspaceDatabase: Database, runId: string): Promise<Target[]> {
  const { rows: [run] } = await database.query<{ userId: string; botId: string | null }>(
    `SELECT r."userId",r."botId" FROM agent_runs r JOIN bots b ON b.id=r."botId"
     WHERE r.id=$1 AND r."workspaceId"=b."workspaceId" AND r."userId"=b."ownerId"`, [runId])
  return run?.botId ? botChatTargets(database, workspaceDatabase, run.userId, run.botId, false) : []
}

type Resolve = (database: Database, workspaceDatabase: Database) => Promise<Target[]>

/** Register at the real writer: nothing is sent before the outer COMMIT, and a rollback sends nothing. */
async function changed(executor: object, key: string, resolve: Resolve) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive } = await import('./notify')
  afterDatabaseCommit(executor, `chat:${key}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await resolve(pool, workspacePool)
      await (await import('./publish')).sendLiveTargets(pool, targets)
    })
  }))
}

/** A committed message, inbox event or turn state in one chat: its bot list row and the open chat re-read. */
export const botChatChanged = (executor: object, ownerId: string, botId: string | null) => changed(executor, `${ownerId}:${botId ?? ''}`, (database, workspace) => botChatTargets(database, workspace, ownerId, botId))
/** A run's state changed: the chat that cites it re-reads; its list rows are runListChanged's. */
export const runBotChatChanged = (executor: object, runId: string) => changed(executor, `run:${runId}`, (database, workspace) => runBotChatTargets(database, workspace, runId))
