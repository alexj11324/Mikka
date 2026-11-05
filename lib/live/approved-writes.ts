import type { PoolClient } from 'pg'
import { afterCommit } from '../db/commit-effects'
import { WRITE_ACTIONS } from '../operations/write-schema'
import { liveGatewayConfig, type LiveScope } from './scope'
import type { LiveInvalidation } from './events'

type Database = Pick<PoolClient, 'query'>

/** Personal-account proposals retain their existing owner-wide authority. The
 * transport uses that owner's real personal workspace, never the selected Bot
 * workspace. No input, provider/account identifiers or result enters the key. */
export async function approvedWriteTargets(database: Database, workspaceDatabase: Database, id: string, ownerId: string) {
  const proposal = await database.query(
    'SELECT id FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action=ANY($3::text[]) AND "operationBinding" IS NOT NULL',
    [id, ownerId, WRITE_ACTIONS],
  )
  if (!proposal.rowCount) return []
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT w."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=w."userId" AND m.status='active'
      WHERE w."userId"=$1 AND w.kind='personal'`, [ownerId],
  )
  return rows.map(scope => ({ scope, events: [
    { kind: 'approved_writes', id: scope.workspaceId }, { kind: 'approved_write', id },
  ] as LiveInvalidation[] }))
}

/** Register only after an actual proposal/projection-changing ledger write.
 * The existing observer follows writeTransaction's proxy to the real COMMIT;
 * rollback, aborted authorization and reads never publish. */
export async function approvedWriteChanged(client: PoolClient, id: string, ownerId: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterCommit(client, `approved-write:${ownerId}:${id}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await approvedWriteTargets(pool, workspacePool, id, ownerId)
      await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, target.events)))
    })
  }))
}
