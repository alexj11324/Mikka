import { AsyncLocalStorage } from 'node:async_hooks'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@/lib/db/schema'
import type { PolicyClient } from '@/lib/policy/sql-client'
import type { PoolClient } from 'pg'
import { resourceWakeAdmission } from './wake-admission'
import 'server-only'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { issueForUser } from '@/lib/issue-access'
import {
  CoordinatorInbox,
  WakeError,
  type InboxOptions,
  type WakeAuthorization,
  type WakeScopeGuard,
  type WakeDelivery,
} from './inbox-receipts'
import { controlledWakeConfiguration } from './wake-controlled'
import { WORKSPACE_ID } from '@/lib/device-link'

const workspaceScope = new AsyncLocalStorage<Pick<typeof workspaceDb,'select'>>()
const authorize: WakeAuthorization = async (tx, event) => {
  if (!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [event.userId])).rowCount)
    throw new WakeError('wakeOwnerUnavailable', 403)
  if (event.payload.workspaceId && event.payload.workspaceId !== event.wake_workspace_id)
    throw new WakeError('wakeWorkspaceMismatch', 403)
  if (event.wake_workspace_id) {
    const active = await (workspaceScope.getStore() ?? workspaceDb)
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, event.wake_workspace_id),
          eq(workspaceMembers.userId, event.userId),
          eq(workspaceMembers.status, 'active'),
        ),
      )
      .limit(1)
    if (!active.length) throw new WakeError('wakeWorkspaceAccessDenied', 403)
  }
  if (
    event.issueId &&
    !(await issueForUser(
      event.userId,
      event.issueId,
      false,
      drizzle(tx, { schema }),
      workspaceScope.getStore() ?? workspaceDb,
    ))
  )
    throw new WakeError('wakeIssueAccessDenied', 403)
  if (event.runId) {
    const run = (
      await tx.query(
        `SELECT r."userId",r.status,r."stopRequestedAt",d."ownerId",m."workspaceId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" LEFT JOIN session_mailboxes m ON m.id=r."mailboxId" WHERE r.id=$1 FOR SHARE OF r,d`,
        [event.runId],
      )
    ).rows[0]
    if (!run || run.userId !== event.userId || run.ownerId !== event.userId)
      throw new WakeError('wakeRunAccessDenied', 403)
    if (
      run.workspaceId &&
      run.workspaceId !== WORKSPACE_ID &&
      event.wake_workspace_id &&
      run.workspaceId !== event.wake_workspace_id
    )
      throw new WakeError('wakeWorkspaceMismatch', 403)
    if (run.stopRequestedAt || ['cancelled', 'stopped'].includes(run.status)) return 'notify_only'
  }
  return 'normal'
}
const scopeGuard: WakeScopeGuard = async (event, _phase, work) => {
  if (!event.wake_workspace_id && !event.issueId) return work()
  return workspaceDb.transaction(async (tx) => {
    try {
      if (event.wake_workspace_id) await requireWorkspace(tx, event.wake_workspace_id, event.userId)
    } catch (e) {
      if (e instanceof WorkspaceError) throw new WakeError('wakeWorkspaceAccessDenied', 403)
      throw e
    }
    return workspaceScope.run(tx, work)
  })
}
export function coordinatorInboxOptions(): InboxOptions {
  const controlled = controlledWakeConfiguration()
  return {
    authorize,
    scopeGuard,
    ...(controlled ? { leaseMs: 1000, deliveryLeaseMs: 250, retryBaseMs: 100 } : {}),
    admit: controlled ? async () => ({ admitted: true as const }) : resourceWakeAdmission,
  }
}
export function coordinatorInbox() {
  return new CoordinatorInbox(pool, coordinatorInboxOptions())
}

/** Called in the canonical quota transaction, while the public policy adapter
 * holds the exact workspace membership/policy locks. No nested pool borrow. */
export async function fenceCoordinatorModel(tx:PoolClient,workspace:PolicyClient,input:{ownerId:string;workspaceId:string;eventId:string;generation:number;holder:string;delivery:WakeDelivery},deadline:Date){
  const session=(await tx.query('SELECT * FROM coordinator_sessions WHERE "userId"=$1 FOR SHARE',[input.ownerId])).rows[0]
  const event=(await tx.query('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR SHARE',[input.eventId,input.ownerId])).rows[0]
  if(!session||!event||event.wake_replays!==input.generation||event.wake_workspace_id!==input.workspaceId||event.processed_at||event.wake_checkpoint||event.wake_status!=='running'||event.wake_generation_state!=='sending'||!['attention','result'].includes(event.tier)||event.kind==='issue_done'||event.wake_delivery_token!==input.delivery.token||event.processing_holder!==input.holder||session.leaseHolder!==input.holder||!session.leaseUntil||session.leaseUntil<=deadline)throw new WakeError('wakeLeaseLost')
  const mode=await workspaceScope.run(drizzle(workspace as PoolClient),()=>authorize(tx,event,'commit'))
  if(mode==='notify_only')throw new WakeError('wakeRunStopped')
}

export async function fenceCoordinatorTriage(tx:PoolClient,workspace:PolicyClient,input:{ownerId:string;workspaceId:string;eventId:string;generation:number}){
  const event=(await tx.query('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR SHARE',[input.eventId,input.ownerId])).rows[0]
  if(!event||event.wake_replays!==input.generation||event.wake_workspace_id!==input.workspaceId||event.processed_at||event.deliveredAt||event.tier!==null||!['pending','running'].includes(event.wake_status))throw new WakeError('wakeLeaseLost')
  if(await workspaceScope.run(drizzle(workspace as PoolClient),()=>authorize(tx,event,'dispatch'))==='notify_only')throw new WakeError('wakeRunStopped')
}
