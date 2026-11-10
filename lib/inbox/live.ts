import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import { liveGatewayConfig } from '@/lib/live/scope'

/** Accepted suggestions use the same read key as reject and snooze. Register
 * on the writer so a failed submission or outer rollback emits nothing. */
export async function suggestionInboxChanged(executor: object, userId: string, botId: string | null) {
  if (!liveGatewayConfig(process.env)) return
  afterDatabaseCommit(executor, `inbox-suggestion:${userId}:${botId}`, async () => {
    const { scheduleLive } = await import('@/lib/live/notify')
    scheduleLive(async () => {
      const { pool, withoutDatabaseClient } = await import('@/lib/db/request-scope')
      const { workspacePool } = await import('@/lib/workspace-db')
      await withoutDatabaseClient(async () => {
        const scope = botId ? (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, userId])).rows[0]
          : (await workspacePool.query<{ workspaceId: string }>('SELECT id AS "workspaceId" FROM mikka_workspaces WHERE "userId"=$1 AND kind=\'personal\'', [userId])).rows[0]
        if (scope) await (await import('./runtime')).inboxChanged(userId, scope.workspaceId)
      })
    })
  })
}
