import 'server-only'
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db'
import { enqueueIdentityAudit } from './audit-outbox'
import { armDueTimerSoon } from '../due-timer'

type Query = Pick<PoolClient, 'query'>
export type HandoffRoot = { id: string; organizationId: string | null; providerId: string | null; identityId: string | null; expiresAt: Date }
type Scope = { userId: string; organizationId: string; providerId: string; identityId: string }
type Snapshot = { sessionId: string; providerId: string; nameID: string; sessionIndex?: string }
export type VerifiedSamlLogout = { providerId: string; nameID: string; sessionIndex?: string | string[] | null }
const byId = (id: string) => `saml-session-by-id:${id}`
const snapshotKey = (id: string) => `enterprise-saml-session:${id}`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function invalid(): never { throw new Error('enterprise_handoff_invalid') }

/** Normalize before locking: every descendant holds the original root first,
 * matching PostgreSQL's native root FK cascade. No Workspace lock or second APP checkout. */
export async function lockHandoffRoot(tx: Query, sourceSessionId: string, userId: string): Promise<HandoffRoot | undefined> {
  const { rows: [selected] } = await tx.query<{ id: string }>(`select coalesce(lineage."rootSessionId",s.id) as id from session s
    left join enterprise_saml_session_lineage lineage on lineage."sessionId"=s.id where s.id=$1 and s."userId"=$2`, [sourceSessionId, userId])
  if (!selected) return
  const { rows: [root] } = await tx.query<HandoffRoot>(`select id,"enterpriseOrganizationId" as "organizationId",
    "enterpriseProviderId" as "providerId","enterpriseIdentityId" as "identityId","expiresAt"
    from session where id=$1 and "userId"=$2 and "expiresAt">now() and "enterpriseSamlRootSessionId" is null for update`, [selected.id, userId])
  return root
}

async function nativeSnapshot(tx: Query, sessionId: string, providerId: string) {
  const { rows: [lookup] } = await tx.query<{ value: string; expiresAt: Date }>(`select value,"expiresAt" from verification
    where identifier=$1 and "expiresAt">now() order by "createdAt" desc limit 1`, [byId(sessionId)])
  if (!lookup || !(lookup.value.startsWith(`saml-session:${providerId}:`) || lookup.value === snapshotKey(sessionId))) invalid()
  const { rows } = await tx.query<{ value: string; expiresAt: Date }>(`select value,"expiresAt" from verification
    where identifier=$1 and "expiresAt">now() order by "createdAt" desc`, [lookup.value])
  for (const candidate of rows) {
    let value: unknown
    try { value = JSON.parse(candidate.value) } catch { continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const data = value as Record<string, unknown>
    if (data.sessionId !== sessionId || data.providerId !== providerId || typeof data.nameID !== 'string' || !data.nameID
      || (data.sessionIndex !== undefined && typeof data.sessionIndex !== 'string')) continue
    const snapshot: Snapshot = { sessionId, providerId, nameID: data.nameID, ...(typeof data.sessionIndex === 'string' ? { sessionIndex: data.sessionIndex } : {}) }
    return { snapshot, expiresAt: new Date(Math.min(lookup.expiresAt.getTime(), candidate.expiresAt.getTime())) }
  }
  invalid()
}

async function saveSnapshot(tx: Query, snapshot: Snapshot, expiresAt: Date, existing: boolean) {
  const key = snapshotKey(snapshot.sessionId)
  await tx.query(`insert into verification (id,identifier,value,"expiresAt","createdAt","updatedAt") values ($1,$1,$2,$3,now(),now())
    on conflict (id) do update set value=excluded.value,"expiresAt"=excluded."expiresAt","updatedAt"=now()`, [key, JSON.stringify(snapshot), expiresAt])
  if (existing) await tx.query('update verification set value=$2 where identifier=$1', [byId(snapshot.sessionId), key])
  else await tx.query(`insert into verification (id,identifier,value,"expiresAt","createdAt","updatedAt") values (gen_random_uuid()::text,$1,$2,$3,now(),now())`, [byId(snapshot.sessionId), key, expiresAt])
}

async function addLineage(tx: Query, input: Scope, snapshot: Snapshot, rootSessionId: string) {
  await tx.query(`insert into enterprise_saml_session_lineage ("sessionId","rootSessionId","userId","organizationId","providerId","identityId","nameIdHash","sessionIndexHash")
    values ($1,$2,$3,$4,$5,$6,$7,$8)`, [snapshot.sessionId, rootSessionId, input.userId, input.organizationId, input.providerId, input.identityId,
    hash(snapshot.nameID), snapshot.sessionIndex === undefined ? null : hash(snapshot.sessionIndex)])
}

/** After native signature/issuer/request validation and before the login audit
 * barrier publishes a cookie, retain this exact root's minimal SLO metadata.
 * A later login cannot replace it through the native provider+NameID index. */
export async function registerSamlSession(input: Scope & { sessionId: string }) {
  const tx = await pool.connect()
  try {
    await tx.query('begin')
    await tx.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    const root = await lockHandoffRoot(tx, input.sessionId, input.userId)
    if (!root || root.id !== input.sessionId || root.organizationId !== input.organizationId || root.providerId !== input.providerId || root.identityId !== input.identityId) invalid()
    const { snapshot, expiresAt } = await nativeSnapshot(tx, input.sessionId, input.providerId)
    await saveSnapshot(tx, snapshot, new Date(Math.min(expiresAt.getTime(), root.expiresAt.getTime())), true)
    await addLineage(tx, input, snapshot, root.id)
    await tx.query('commit')
  } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
}

/** Native SP SLO reads the by-id verification index and NameID/SessionIndex.
 * The private snapshot contains no session token or raw assertion. */
export async function inheritSamlSession(tx: Query, input: Scope & { sourceSessionId: string; targetSessionId: string; root: HandoffRoot }) {
  const { root } = input
  if (root.organizationId !== input.organizationId || root.providerId !== input.providerId || root.identityId !== input.identityId) invalid()
  const { snapshot, expiresAt } = await nativeSnapshot(tx, input.sourceSessionId, input.providerId)
  const { rows: [target] } = await tx.query<{ expiresAt: Date }>(`update session set "expiresAt"=least("expiresAt",$2::timestamptz),"enterpriseSamlRootSessionId"=$4
    where id=$1 and "userId"=$3 returning "expiresAt"`, [input.targetSessionId, new Date(Math.min(root.expiresAt.getTime(), expiresAt.getTime())), input.userId, root.id])
  if (!target || target.expiresAt.getTime() <= Date.now()) invalid()
  const child = { ...snapshot, sessionId: input.targetSessionId }
  await addLineage(tx, input, child, root.id)
  await saveSnapshot(tx, child, target.expiresAt, false)
}

/** Called only by the pinned native SAML parser AFTER its cryptographic,
 * issuer/destination and persistent replay checks. The handled result skips
 * the native single-record cleanup, including a later login's canonical key.
 * An absent SessionIndex closes all current roots for this provider+NameID. */
export async function revokeVerifiedSamlSessions(input: VerifiedSamlLogout): Promise<true> {
  if (typeof input.nameID !== 'string' || !input.nameID) invalid()
  // samlify 2.15.1 returns null for no SessionIndex, a string for one,
  // and an array for multiple elements. This input has already passed native
  // signature, issuer, destination and one-use request validation.
  const values = input.sessionIndex == null ? null : typeof input.sessionIndex === 'string' ? [input.sessionIndex] : input.sessionIndex
  if (values !== null && (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !value))) invalid()
  const indices = values === null ? null : [...new Set(values)].map(hash)
  const tx = await pool.connect()
  let audited = false
  const revokedUsers = new Set<string>()
  try {
    await tx.query('begin')
    await tx.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    const { rows } = await tx.query<Scope & { id: string }>(`select root.id,lineage."userId",lineage."organizationId"::text as "organizationId",lineage."providerId",lineage."identityId"::text as "identityId"
      from enterprise_saml_session_lineage lineage join session root on root.id=lineage."sessionId"
      join enterprise_sso_provider p on p."providerId"=lineage."providerId" and p."organizationScopeId"=lineage."organizationId"
      where lineage."sessionId"=lineage."rootSessionId" and lineage."providerId"=$1 and lineage."nameIdHash"=$2
        and ($3::text[] is null or lineage."sessionIndexHash"=any($3))
        and root."userId"=lineage."userId" and root."enterpriseOrganizationId"=lineage."organizationId"::text
        and root."enterpriseProviderId"=lineage."providerId" and root."enterpriseIdentityId"=lineage."identityId"::text
      order by root.id for update of root`, [input.providerId, hash(input.nameID), indices])
    for (const root of rows) {
      await tx.query('delete from session where id=$1', [root.id])
      await enqueueIdentityAudit(tx, { organizationId: root.organizationId, actorId: `saml:${input.providerId}`, action: 'sso.signed_out', targetId: root.id,
        metadata: { providerId: input.providerId, reason: 'saml_idp_logout' } })
      audited = true
      revokedUsers.add(root.userId)
    }
    await tx.query('commit')
  } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
  if (audited) {
    armDueTimerSoon('audit-retention')
    const { scheduleSessionLiveRevocation } = await import('./live-authority')
    for (const userId of revokedUsers) {
      scheduleSessionLiveRevocation(userId)
      await (await import('@/lib/resource-access/lifecycle')).sessionResourceAuthorityChanged(userId)
    }
  }
  return true
}

/** Called only for an authenticated SP logout of this exact provider. */
export async function derivedSamlRoot(sessionId: string, userId: string, organizationId: string, providerId: string): Promise<{ rootSessionId: string; identityId: string } | undefined> {
  const { rows: [row] } = await pool.query<{ rootSessionId: string; identityId: string }>(`select lineage."rootSessionId",lineage."identityId"::text as "identityId" from enterprise_saml_session_lineage lineage
    join session s on s.id=lineage."sessionId" join session root on root.id=lineage."rootSessionId"
    where lineage."sessionId"=$1 and lineage."sessionId"<>lineage."rootSessionId" and lineage."userId"=$2 and lineage."organizationId"=$3 and lineage."providerId"=$4
      and s."userId"=$2 and root."userId"=$2 and s."enterpriseProviderId"=$4 and root."enterpriseProviderId"=$4
      and s."enterpriseOrganizationId"=$3::text and root."enterpriseOrganizationId"=$3::text
      and s."enterpriseIdentityId"=lineage."identityId"::text and root."enterpriseIdentityId"=lineage."identityId"::text`, [sessionId, userId, organizationId, providerId])
  return row
}

/** After the native endpoint confirmed its redirect and deleted the child,
 * close only that original SAML login. Its native FK cascade closes sibling clones. */
export async function finishDerivedSamlLogout(proof: { rootSessionId: string; identityId: string; sessionId: string; userId: string; organizationId: string; providerId: string }) {
  const deleted = await pool.query(`delete from session root where root.id=$1 and root."userId"=$2 and root."enterpriseOrganizationId"=$3
    and root."enterpriseProviderId"=$4 and root."enterpriseIdentityId"=$6 and not exists(select 1 from session child where child.id=$5)`,
  [proof.rootSessionId, proof.userId, proof.organizationId, proof.providerId, proof.sessionId, proof.identityId])
  if (deleted.rowCount) {
    (await import('./live-authority')).scheduleSessionLiveRevocation(proof.userId)
    await (await import('@/lib/resource-access/lifecycle')).sessionResourceAuthorityChanged(proof.userId)
  }
}
