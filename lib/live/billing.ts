import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/**
 * A workspace's hosted balance or card verification changed (a Stripe webhook
 * committed it). Its active members re-read the balance there (`hosted_billing`,
 * the workspace ID). A card is the person's and lands on their personal
 * workspace (C19), whose verification shows wherever they are, so its owner
 * also gets the key in every workspace they are an active member of. No amount,
 * card or customer crosses the channel; every read is still authorized.
 */
export async function hostedBillingTargets(workspaceDatabase: Database, workspaceId: string): Promise<Target[]> {
  if (!LIVE_ID.test(workspaceId)) return []
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT m."userId" AS "ownerId",m."workspaceId" FROM mikka_workspace_members m WHERE m."workspaceId"=$1 AND m.status='active'
     UNION
     SELECT m."userId",m."workspaceId" FROM mikka_workspaces w
       JOIN mikka_workspace_members home ON home."workspaceId"=w.id AND home."userId"=w."userId" AND home.status='active'
       JOIN mikka_workspace_members m ON m."userId"=w."userId" AND m.status='active'
       WHERE w.id=$1 AND w.kind='personal'`, [workspaceId],
  )
  return rows.map(scope => ({ scope, events: [{ kind: 'hosted_billing', id: scope.workspaceId }] }))
}

/** Register at the writer: sent after the outer COMMIT; a rollback sends nothing. */
export async function hostedBillingChanged(executor: object, workspaceId: string) {
  if (!liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `hosted_billing:${workspaceId}`, () => scheduleLive(async () => {
    const { withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const targets = await hostedBillingTargets(workspacePool, workspaceId)
      await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, target.events)))
    })
  }))
}
