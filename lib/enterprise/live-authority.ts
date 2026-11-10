import 'server-only'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { withoutDatabaseClient } from '@/lib/db/request-scope'
import { afterJob } from '@/lib/background'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaces, workspaceMembers } from '@/lib/db/workspace-schema'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import { WorkspaceError } from '@/lib/workspace-error'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace, activeTaskWorkspaces } from '@/lib/task-workspace'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { liveChannelId, liveChannelTicket, liveTicket, type LiveScope, liveGatewayConfig } from '@/lib/live/scope'
import { armDueTimerSoon } from '@/lib/due-timer'
import { enterprisePrincipal } from './principal'
import { enterpriseWorkspaceAllowed } from './access'
import { currentLiveCapabilities, hasEnterpriseLiveScope, lockLiveCapability, lockLiveRegistration,
  registerEnterpriseLiveCapability, rememberEnterpriseLiveScope, revokeWorkspaceLiveCapabilities, type EnterpriseLiveCapability } from './live-store'

type GatewayConfig = NonNullable<ReturnType<typeof liveGatewayConfig>>
type TicketResult = { status: 'allowed'; ticket: ReturnType<typeof liveTicket> } | { status: 'denied' } | { status: 'pending' }
type RevokeFilter = { organizationId?: string; workspaceId?: string; userId?: string }
const sessionReader = (userId: string, sessionId: string) => ({ id: userId, [enterprisePrincipal]: { kind: 'session' as const, sessionId } })

async function linkedOrganization(tx: WorkspaceTransaction, workspaceId: string): Promise<string | null> {
  const [link] = await tx.select({ organizationId: organizationWorkspaces.organizationId }).from(organizationWorkspaces)
    .where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
  return link?.organizationId ?? null
}

/** WS row -> member row, matching P0 task writers. No APP connection is held
 * while these locks are acquired. Binding/unbinding cannot overtake a send. */
async function withLiveScope<T>(scope: LiveScope, work: (organizationId: string | null, kind: 'personal' | 'team', tx: WorkspaceTransaction) => Promise<T>): Promise<T | null> {
  return workspaceDb.transaction(async tx => {
    const [workspace] = await tx.select({ kind: workspaces.kind, userId: workspaces.userId }).from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId)).for('share').limit(1)
    if (!workspace || workspace.kind === 'personal' && workspace.userId !== scope.ownerId) return null
    const [member] = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, scope.workspaceId), eq(workspaceMembers.userId, scope.ownerId), eq(workspaceMembers.status, 'active'))).for('share').limit(1)
    if (!member) return null
    return work(workspace.kind === 'personal' ? null : await linkedOrganization(tx, scope.workspaceId), workspace.kind, tx)
  })
}

/** The request's real session is reauthorized with the already owned APP
 * client. Its advisory locks serialize registration with policy/SCIM/session
 * revocation without a session row lock or a second pool checkout. */
export async function workspaceLiveTicket(scope: LiveScope, sessionId: string, config: GatewayConfig): Promise<TicketResult> {
  let registered: { ticket: ReturnType<typeof liveTicket> } | { capability: EnterpriseLiveCapability | null }
  try {
    registered = await withTaskWorkspace(sessionReader(scope.ownerId, sessionId), scope.workspaceId, async (workspace, workspaceTx) => {
      const organizationId = workspace.kind === 'personal' ? null : await linkedOrganization(workspaceTx, scope.workspaceId)
      if (!organizationId && (workspace.kind === 'personal' || !await hasEnterpriseLiveScope(pool, scope))) {
        return { ticket: liveTicket(scope, config, Date.now(), sessionId) }
      }
      const capability = await writeTransaction(pool, async tx => {
        await lockLiveRegistration(tx, organizationId, sessionId)
        if (!await enterpriseWorkspaceAllowed(scope.ownerId, scope.workspaceId, { kind: 'session', sessionId }, workspaceTx, tx)) {
          throw new WorkspaceError('workspaceAccessDenied')
        }
        if (organizationId) await rememberEnterpriseLiveScope(tx, scope, organizationId)
        return registerEnterpriseLiveCapability(tx, scope, organizationId, sessionId)
      })
      return { capability }
    })
  } catch (error) {
    if (error instanceof WorkspaceError || error instanceof ActionFailureError) return { status: 'denied' }
    throw error
  }
  if ('ticket' in registered) return { status: 'allowed', ticket: registered.ticket }
  const capability = registered.capability
  if (!capability) return { status: 'denied' }
  armDueTimerSoon('audit-retention')
  // Revoke the pre-Enterprise ambient channel before claiming that this
  // gateway has accepted the safe replacement. Existing reconnect backoff
  // retries a null ticket; this does not add a new polling mechanism.
  const delivery = await drainLiveRevocations({ workspaceId: scope.workspaceId, userId: scope.ownerId })
  if (delivery.pending) return { status: 'pending' }
  return { status: 'allowed', ticket: liveChannelTicket(capability.channel, config, Date.now(), sessionId, capability.expiresAt.getTime()) }
}

/** Every send, including the last ambient send before an Org is attached,
 * retains the WS lock. Enterprise fan-out is per session capability; the
 * policy/SCIM source barrier is checked again under its APP row lock. */
export async function sendEnterpriseLiveInvalidations(scope: LiveScope, send: (channel: string) => Promise<void>): Promise<void> {
  await withLiveScope(scope, async (organizationId, kind, workspaceTx) => {
    const managed = organizationId !== null || kind !== 'personal' && await hasEnterpriseLiveScope(pool, scope)
    if (!managed) { await send(liveChannelId(scope)); return }
    if (organizationId) await rememberEnterpriseLiveScope(pool, scope, organizationId)
    const capabilities = await currentLiveCapabilities(pool, scope, organizationId)
    for (const capability of capabilities) {
      if (!await enterpriseWorkspaceAllowed(scope.ownerId, scope.workspaceId,
        { kind: 'session', sessionId: capability.sessionId }, workspaceTx)) continue
      await writeTransaction(pool, async tx => {
        if (await lockLiveCapability(tx, capability)) await send(capability.channel)
      })
    }
  })
}

/** Persist the ambient tombstone before the WS binding commits. The APP
 * commit may survive a rolled-back WS change; that only switches the scope
 * conservatively to fresh session capabilities and never grants membership. */
export async function markWorkspaceLiveBinding(workspaceId: string, organizationId: string, workspaceTx: WorkspaceTransaction) {
  const members = await workspaceTx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
  await writeTransaction(pool, async tx => {
    await tx.query('update enterprise_live_capabilities set "revokedAt"=now() where kind=\'session\' and "workspaceId"=$1 and "revokedAt" is null', [workspaceId])
    for (const member of members) await rememberEnterpriseLiveScope(tx, { workspaceId, ownerId: member.userId }, organizationId)
  })
}

/** Called after the binding transaction commits, never from an APP tx.
 * Old shared channels are durable tombstones; even a later detach keeps the
 * secure per-session channel mode instead of reviving an old ticket. */
export async function fenceWorkspaceLive(workspaceId: string) {
  await workspaceDb.transaction(async tx => {
    const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('share').limit(1)
    if (!workspace) return
    const organizationId = await linkedOrganization(tx, workspaceId)
    if (!organizationId) return
    const members = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
    await writeTransaction(pool, async main => {
      for (const member of members) await rememberEnterpriseLiveScope(main, { workspaceId, ownerId: member.userId }, organizationId)
    })
  })
  armDueTimerSoon('audit-retention')
  if (liveGatewayConfig(process.env)) return drainLiveRevocations({ workspaceId })
  return { delivered: 0, failed: 0, pending: true }
}

/** Binding changes cannot revive old tickets, even after a later detach. */
export async function retireWorkspaceLiveBinding(workspaceId: string, organizationId: string | null) {
  await writeTransaction(pool, tx => revokeWorkspaceLiveCapabilities(tx, workspaceId, organizationId))
  armDueTimerSoon('audit-retention')
  if (liveGatewayConfig(process.env)) return drainLiveRevocations({ workspaceId })
  return { delivered: 0, failed: 0, pending: true }
}

export async function drainOrganizationLiveRevocations(organizationId: string) {
  // This initial WS read and each fence's WS -> APP transaction finish before
  // the network delivery/receipt queries start. No APP -> WS checkout.
  const links = await workspaceDb.select({ workspaceId: organizationWorkspaces.workspaceId }).from(organizationWorkspaces)
    .where(eq(organizationWorkspaces.organizationId, organizationId))
  for (const link of links) await fenceWorkspaceLive(link.workspaceId)
  if (liveGatewayConfig(process.env)) return drainLiveRevocations({ organizationId })
  return { delivered: 0, failed: 0, pending: true }
}

/** Better Auth/native SLO call this only after their Auth commit. The
 * database trigger already closed the source barrier; this wakes the existing
 * durable maintenance path and sends Worker controls without retaining the
 * completed Auth transaction's client or waiting inside its native hook. */
export function scheduleSessionLiveRevocation(userId: string): void {
  armDueTimerSoon('audit-retention')
  afterJob('after:enterprise-live-revoke', () => withoutDatabaseClient(async () => {
    try { await drainLiveRevocations({ userId }) }
    catch (error) {
      console.warn('[live] session revocation delivery pending', {
        name: (error as Error | undefined)?.name, code: (error as { code?: unknown } | undefined)?.code,
      })
    }
  }), { orRun: true, retainContext: true })
}

/** Durable delivery shares the existing audit-maintenance scheduler. Only an
 * explicit gateway ACK completes a row; old Workers or network failure leave
 * the already committed source barrier closed and retryable. */
export async function drainLiveRevocations(filter: RevokeFilter = {}, force = true,
  revoke?: (channel: string) => Promise<boolean>) {
  if (!revoke && !liveGatewayConfig(process.env)) return { delivered: 0, failed: 0, pending: true }
  const values = [filter.organizationId ?? null, filter.workspaceId ?? null, filter.userId ?? null, force]
  const { rows } = await pool.query<{ channel: string }>(`with pending as (
    select channel from enterprise_live_capabilities where "revokedAt" is not null and "deliveredAt" is null
      and ($1::uuid is null or "organizationId"=$1) and ($2::uuid is null or "workspaceId"=$2) and ($3::text is null or "userId"=$3)
      and ($4 or "lastAttemptAt" is null or "lastAttemptAt"<=now()-interval '30 seconds')
    order by "lastAttemptAt" nulls first,"createdAt",channel for update skip locked limit 100)
    update enterprise_live_capabilities c set "lastAttemptAt"=now() from pending p where c.channel=p.channel returning c.channel`, values)
  const deliver = revoke ?? (await import('@/lib/live/notify')).revokeLiveChannel
  let delivered = 0, failed = 0
  // No checkout or row lock is retained during revocation transport. The
  // capability is already revoked; duplicate controls are idempotent.
  for (let start = 0; start < rows.length; start += 4) await Promise.all(rows.slice(start, start + 4).map(async row => {
    let acknowledged = false
    try { acknowledged = await deliver(row.channel) } catch { /* keep the durable retry */ }
    if (!acknowledged) { failed++; return }
    await pool.query('update enterprise_live_capabilities set "deliveredAt"=now() where channel=$1 and "revokedAt" is not null and "deliveredAt" is null', [row.channel])
    delivered++
  }))
  const { rows: [remaining] } = await pool.query<{ pending: boolean }>(`select exists(select 1 from enterprise_live_capabilities
    where "revokedAt" is not null and "deliveredAt" is null
      and ($1::uuid is null or "organizationId"=$1) and ($2::uuid is null or "workspaceId"=$2) and ($3::text is null or "userId"=$3)) as pending`, values.slice(0, 3))
  return { delivered, failed, pending: remaining?.pending === true }
}

/** A signed channel is still only a capability claim. Builtin upgrade/open
 * resolves its persisted tenant and uses the same explicit session principal
 * as normal P2 reads, including SAML-root and SCIM barriers. */
export async function authorizeEnterpriseLiveChannel(sessionId: string, channel: string): Promise<boolean> {
  const { rows: [session] } = await pool.query<{ userId: string }>('select "userId" from session where id=$1 and "expiresAt">now()', [sessionId])
  if (!session) return false
  const { rows: [capability] } = await pool.query<EnterpriseLiveCapability & { kind: string; revokedAt: Date | null }>(
    'select * from enterprise_live_capabilities where channel=$1', [channel])
  const reader = sessionReader(session.userId, sessionId)
  if (capability) {
    if (capability.kind !== 'session' || capability.revokedAt || capability.sessionId !== sessionId
      || capability.userId !== session.userId || capability.expiresAt.getTime() <= Date.now()) return false
    return await withLiveScope({ ownerId: session.userId, workspaceId: capability.workspaceId }, async (organizationId, _kind, workspaceTx) =>
      organizationId === capability.organizationId
      && await enterpriseWorkspaceAllowed(session.userId, capability.workspaceId, { kind: 'session', sessionId }, workspaceTx)) === true
  }
  // Legacy builtin personal/unmanaged channels remain supported. An Org
  // channel is never authorized through that ambient fallback.
  for (const workspace of await activeTaskWorkspaces(reader)) {
    const scope = { ownerId: session.userId, workspaceId: workspace.id }
    if (liveChannelId(scope) !== channel) continue
    if (workspace.kind === 'personal') return true
    const [link] = await workspaceDb.select({ workspaceId: organizationWorkspaces.workspaceId }).from(organizationWorkspaces)
      .where(eq(organizationWorkspaces.workspaceId, workspace.id)).limit(1)
    return !link && !await hasEnterpriseLiveScope(pool, scope)
  }
  return false
}
