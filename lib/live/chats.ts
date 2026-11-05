import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { ownerLiveScope } from './owner-scope'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** A bot chat is private to its owner. Its keys go only to the owner's actual
 * home channel: the bot list's key (the home ID) and, while the owner still
 * owns the bot, that chat's own key (the bot ID). Neither carries a message. */
export async function botChatTargets(database: Database, workspaceDatabase: Database, ownerId: string, botId: string | null, list = true): Promise<Target[]> {
  const scope = await ownerLiveScope(workspaceDatabase, ownerId)
  if (!scope) return []
  const events: LiveInvalidation[] = list ? [{ kind: 'bot_chat_list', id: scope.workspaceId }] : []
  if (botId && LIVE_ID.test(botId)) {
    const { rowCount } = await database.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, ownerId])
    if (rowCount) events.push({ kind: 'bot_chat', id: botId })
  }
  return events.length ? [{ scope, events }] : []
}

/** A run's state shows on its cards in its own bot's chat, for the run's owner only. */
export async function runBotChatTargets(database: Database, workspaceDatabase: Database, runId: string): Promise<Target[]> {
  const { rows: [run] } = await database.query<{ userId: string; botId: string | null }>('SELECT "userId","botId" FROM agent_runs WHERE id=$1', [runId])
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
