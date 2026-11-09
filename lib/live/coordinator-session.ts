import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>

/** The authenticated actor owns this persisted Bot; the browser's active
 * workspace and the member who triggered a reply cannot choose its channel. */
export async function coordinatorSessionScope(database: Database, workspaceDatabase: Database, ownerId: string, botId: string): Promise<LiveScope | null> {
  const { rows: [bot] } = await database.query<{ workspaceId: string }>(
    'SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, ownerId],
  )
  if (!bot) return null
  const member = await workspaceDatabase.query(
    `SELECT 1 FROM mikka_workspace_members m JOIN mikka_workspaces w ON w.id=m."workspaceId"
     WHERE w.id=$1 AND m."userId"=$2 AND m.status='active'
       AND (w.kind='team' OR (w.kind='personal' AND w."userId"=$2))`, [bot.workspaceId, ownerId],
  )
  return member.rowCount ? { ownerId, workspaceId: bot.workspaceId } : null
}

/** Register on the actual outer transaction, including Drizzle savepoints.
 * No scope read or network request extends the business transaction. */
export async function coordinatorSessionChanged(executor: object, ownerId: string, botId: string | null) {
  if (!botId || !liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `coordinator_session:${ownerId}:${botId}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const scope = await coordinatorSessionScope(pool, workspacePool, ownerId, botId)
      if (scope) await sendLiveInvalidations(scope, [{ kind: 'coordinator_session', id: botId }])
    })
  }))
}
