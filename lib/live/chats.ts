import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { coordinatorSessionScope } from './coordinator-session'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** A bot chat is private to its owner within the bot's persisted tenant.
 * Recheck membership when delivering; an owner-wide home channel must never
 * receive a different workspace's bot IDs. Neither key carries a message. */
export async function botChatTargets(database: Database, workspaceDatabase: Database, ownerId: string, botId: string | null, list = true): Promise<Target[]> {
  if (!botId || !LIVE_ID.test(botId)) return []
  const scope = await coordinatorSessionScope(database, workspaceDatabase, ownerId, botId)
  if (!scope) return []
  const events: LiveInvalidation[] = list ? [{ kind: 'bot_chat_list', id: scope.workspaceId }] : []
  events.push({ kind: 'bot_chat', id: botId })
  return events.length ? [{ scope, events }] : []
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
