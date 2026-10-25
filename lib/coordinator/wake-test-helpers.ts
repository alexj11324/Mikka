/** Isolated PostgreSQL adapters used by process/HTTP acceptance. Never selected
 * by a user request and never a provider/model implementation. */
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  CoordinatorInbox,
  WakeError,
  type InboxOptions,
  type WakeAuthorization,
  type WakeScopeGuard,
} from './inbox-receipts'
export function isolatedInboxOptions(pool: Pool, members: Pool, clock: () => Date): InboxOptions {
  const authorize: WakeAuthorization = async (tx, event) => {
    if (!(await tx.query('SELECT id FROM "user" WHERE id=$1', [event.userId])).rowCount)
      throw new WakeError('wakeOwnerUnavailable', 403)
    if (event.payload.workspaceId && event.payload.workspaceId !== event.wake_workspace_id)
      throw new WakeError('wakeWorkspaceMismatch', 403)
    if (
      event.wake_workspace_id &&
      !(
        await members.query(
          `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`,
          [event.wake_workspace_id, event.userId],
        )
      ).rowCount
    )
      throw new WakeError('wakeWorkspaceAccessDenied', 403)
    if (event.runId) {
      const run = (
        await tx.query('SELECT "userId",status,"stopRequestedAt" FROM agent_runs WHERE id=$1', [event.runId])
      ).rows[0]
      if (!run || run.userId !== event.userId) throw new WakeError('wakeRunAccessDenied', 403)
      if (run.stopRequestedAt || ['cancelled', 'stopped'].includes(run.status)) return 'notify_only'
    }
    return 'normal'
  }
  const scopeGuard: WakeScopeGuard = async (event, _phase, work) => {
    const tx = await members.connect()
    try {
      await tx.query('BEGIN')
      if (
        event.wake_workspace_id &&
        !(
          await tx.query(
            `SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,
            [event.wake_workspace_id, event.userId],
          )
        ).rowCount
      )
        throw new WakeError('wakeWorkspaceAccessDenied', 403)
      const result = await work()
      await tx.query('COMMIT')
      return result
    } catch (e) {
      await tx.query('ROLLBACK')
      throw e
    } finally {
      tx.release()
    }
  }
  return { authorize, scopeGuard, clock, leaseMs: 1000, deliveryLeaseMs: 250, retryBaseMs: 100 }
}
export async function wakeFixture(pool: Pool) {
  const owner = `wake176-${randomUUID()}`,
    workspace = randomUUID(),
    eventId = randomUUID()
  await pool.query(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())`,
    [owner, `${owner}@example.invalid`],
  )
  await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'wake fixture\')', [workspace, owner])
  await pool.query(
    `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$3,'admin')`,
    [workspace, owner, `${owner}@example.invalid`],
  )
  await pool.query(
    `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,wake_workspace_id) VALUES($1,$2,'user_message',$3,$4,'attention',$5)`,
    [
      eventId,
      owner,
      `wake-fixture:${eventId}`,
      { text: 'Controlled wake result, no provider', workspaceId: workspace },
      workspace,
    ],
  )
  return { owner, workspace, eventId }
}
export async function controlledEffect(pool: Pool, operationId: string) {
  await pool.query(
    'INSERT INTO wake_control_effects(operation_id,executions) VALUES($1,1) ON CONFLICT(operation_id) DO UPDATE SET executions=wake_control_effects.executions+1',
    [operationId],
  )
}
export { CoordinatorInbox }
