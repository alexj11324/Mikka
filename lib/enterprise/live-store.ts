import 'server-only'
import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { liveChannelId, type LiveScope } from '@/lib/live/scope'

export type LiveExecutor = Pick<PoolClient, 'query'>
export type EnterpriseLiveCapability = {
  channel: string; workspaceId: string; userId: string; organizationId: string | null;
  sessionId: string; expiresAt: Date;
}

/** WS locks precede these APP locks. No session row/FK lock follows them. */
export async function lockLiveRegistration(tx: LiveExecutor, organizationId: string | null, sessionId: string) {
  if (organizationId) await tx.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`enterprise-live-org:${organizationId}`])
  await tx.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`enterprise-live-session:${sessionId}`])
}

/** This permanent marker prevents a detached Workspace from ever reusing its
 * pre-Enterprise ambient channel. Valid sessions can obtain new opaque caps. */
export async function rememberEnterpriseLiveScope(tx: LiveExecutor, scope: LiveScope, organizationId: string) {
  await tx.query(`insert into enterprise_live_capabilities
    (channel,kind,"workspaceId","userId","organizationId","revokedAt")
    values ($1,'scope',$2,$3,$4,now()) on conflict (channel) do nothing`,
  [liveChannelId(scope), scope.workspaceId, scope.ownerId, organizationId])
}

export async function hasEnterpriseLiveScope(tx: LiveExecutor, scope: LiveScope): Promise<boolean> {
  const { rows } = await tx.query('select channel from enterprise_live_capabilities where channel=$1 and kind=\'scope\'', [liveChannelId(scope)])
  return rows.length > 0
}

export async function registerEnterpriseLiveCapability(tx: LiveExecutor, scope: LiveScope, organizationId: string | null, sessionId: string): Promise<EnterpriseLiveCapability | null> {
  await tx.query(`update enterprise_live_capabilities set "revokedAt"=now(),
      "deliveredAt"=case when "expiresAt"<=now() then now() else null end
    where kind='session' and "sessionId"=$1 and "workspaceId"=$2 and "revokedAt" is null
      and ("expiresAt"<=now() or "organizationId" is distinct from $3::uuid)`, [sessionId, scope.workspaceId, organizationId])
  const { rows } = await tx.query<EnterpriseLiveCapability>(`insert into enterprise_live_capabilities
      (channel,kind,"workspaceId","userId","organizationId","sessionId","expiresAt")
    select $1,'session',$2,$3,$4,s.id,least(s."expiresAt",now()+interval '5 minutes')
      from session s where s.id=$5 and s."userId"=$3 and s."expiresAt">now()+interval '1 second'
    on conflict ("sessionId","workspaceId") where kind='session' and "revokedAt" is null
      do update set "expiresAt"=excluded."expiresAt"
      where enterprise_live_capabilities."userId"=excluded."userId"
        and enterprise_live_capabilities."organizationId" is not distinct from excluded."organizationId"
    returning channel,"workspaceId","userId","organizationId","sessionId","expiresAt"`,
  [randomBytes(32).toString('hex'), scope.workspaceId, scope.ownerId, organizationId, sessionId])
  return rows[0] ?? null
}

/** Take this before changing authority, but revoke cap rows after any session
 * UPDATEs: native DELETE already owns its session row before its cap trigger. */
export async function lockOrganizationLiveAuthority(tx: LiveExecutor, organizationId: string) {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`enterprise-live-org:${organizationId}`])
}

/** Called in the same APP transaction as policy/SCIM authority changes. Its
 * exclusive lock serializes new registrations; row updates wait for older
 * in-flight sends to finish before the authority transaction can commit.
 * Callers must not lock/update session rows after taking these cap row locks. */
export async function revokeOrganizationLiveCapabilities(tx: LiveExecutor, organizationId: string, userId?: string) {
  await lockOrganizationLiveAuthority(tx, organizationId)
  await tx.query(`update enterprise_live_capabilities set "revokedAt"=now()
    where kind='session' and "organizationId"=$1 and "revokedAt" is null
      and ($2::text is null or "userId"=$2)`, [organizationId, userId ?? null])
}

/** WS binding changes have already serialized senders/registrations. Revoke
 * only the old binding so a new legitimate registration is not swept up. */
export async function revokeWorkspaceLiveCapabilities(tx: LiveExecutor, workspaceId: string, organizationId: string | null) {
  await tx.query(`update enterprise_live_capabilities set "revokedAt"=now()
    where kind='session' and "workspaceId"=$1 and "organizationId" is not distinct from $2::uuid
      and "revokedAt" is null`, [workspaceId, organizationId])
}

export async function currentLiveCapabilities(tx: LiveExecutor, scope: LiveScope, organizationId: string | null) {
  const { rows } = await tx.query<EnterpriseLiveCapability>(`select c.channel,c."workspaceId",c."userId",c."organizationId",c."sessionId",c."expiresAt"
    from enterprise_live_capabilities c join session s on s.id=c."sessionId" and s."userId"=c."userId" and s."expiresAt">now()
    where c.kind='session' and c."workspaceId"=$1 and c."userId"=$2
      and c."organizationId" is not distinct from $3::uuid and c."revokedAt" is null and c."expiresAt">now()`,
  [scope.workspaceId, scope.ownerId, organizationId])
  return rows
}

/** This is the final source barrier. After it, the callback may use transport
 * only, never borrow APP/WS connections or make a second authority query. */
export async function lockLiveCapability(tx: LiveExecutor, capability: EnterpriseLiveCapability): Promise<boolean> {
  const { rows } = await tx.query(`select c.channel from enterprise_live_capabilities c
    where c.channel=$1 and c.kind='session' and c."workspaceId"=$2 and c."userId"=$3
      and c."organizationId" is not distinct from $4::uuid and c."sessionId"=$5
      and c."revokedAt" is null and c."expiresAt">now()
      and exists(select 1 from session s where s.id=c."sessionId" and s."userId"=c."userId" and s."expiresAt">now())
    for share of c`, [capability.channel, capability.workspaceId, capability.userId, capability.organizationId, capability.sessionId])
  return rows.length === 1
}
