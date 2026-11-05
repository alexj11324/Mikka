import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { isApprovalAction } from '../composio-actions'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'

type Database = Pick<PoolClient, 'query'>

/** Legacy cards are owner-wide, matching listPendingActions. The selected Bot
 * workspace never grants visibility. No action inputs or source IDs go on wire. */
export async function pendingActionTargets(database: Database, workspaceDatabase: Database, id: string, ownerId: string) {
  const { rows: proposals } = await database.query<{ action: string }>(
    'SELECT action FROM pending_actions WHERE id=$1 AND "userId"=$2', [id, ownerId],
  )
  const action = proposals[0]?.action
  if (!action || (!isApprovalAction(action) && !['app_tool_call', 'credential_operation', 'browser_operation'].includes(action))) return []
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT w."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=w."userId" AND m.status='active'
      WHERE w."userId"=$1 AND w.kind='personal'`, [ownerId],
  )
  return rows.map(scope => ({ scope, events: [{ kind: 'pending_actions', id: scope.workspaceId }] as LiveInvalidation[] }))
}

/** Call after an actual INSERT into, or transition out of, the visible pending
 * set. The shared adapter follows Drizzle savepoints and request Pool proxies
 * to the real outer COMMIT. Final history/receipt writes never call this. */
export async function pendingActionsChanged(executor: object, id: string, ownerId: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `pending-action:${ownerId}:${id}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await pendingActionTargets(pool, workspacePool, id, ownerId)
      await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, target.events)))
    })
  }))
}
