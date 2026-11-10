import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { organizationMembers, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { enqueueOrganizationAudit } from '@/lib/governance/audit'
import { ScimStore, type DirectoryChange, type ScimConnection } from './scim-store'
import { enqueueMemberLifecycle, drainMemberLifecycleOutbox } from '@/lib/governance/member-outbox'
import type { EnterpriseLoginProof } from './sso-plugin'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { assertOrganizationAccountWritable } from '@/lib/governance/organization-ownership'

export async function synchronizeEnterpriseLogin(proof: EnterpriseLoginProof, audit?: { sessionId: string; correlationId: string }) {
  const { rows } = await pool.query<{ name: string; email: string }>('select name,email from "user" where id=$1', [proof.userId])
  if (!rows[0]) throw new Error('enterprise_identity_missing')
  await workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, proof.userId)
    const [organization] = await tx.select({ archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, proof.organizationId)).for('share').limit(1)
    if (!organization || organization.archivedAt) throw new Error('enterprise_organization_unavailable')
    await tx.insert(organizationMembers).values({ organizationId: proof.organizationId, userId: proof.userId, role: 'member', status: 'active', ...rows[0] }).onConflictDoNothing()
    if (!audit) return
    await enqueueOrganizationAudit(tx, { organizationId: proof.organizationId, actorId: proof.userId, action: 'sso.signed_in', targetId: audit.sessionId,
      correlationId: audit.correlationId, metadata: { providerId: proof.providerId } })
    const memberships = await tx.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
      .innerJoin(organizationWorkspaces, eq(organizationWorkspaces.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(organizationWorkspaces.organizationId, proof.organizationId), eq(workspaceMembers.userId, proof.userId), eq(workspaceMembers.status, 'active')))
    for (const { workspaceId } of memberships) await enqueueWorkspaceAudit(tx, { workspaceId,
      actor: { type: 'user', id: proof.userId, name: rows[0].name }, action: 'auth.signed_in', target: { type: 'session', id: audit.sessionId }, metadata: { method: 'sso' } })
  })
}

/** SCIM directories are administrative membership; groups never grant workspace permissions. */
export async function synchronizeDirectoryUser({ connection, user, action, eventId }: DirectoryChange) {
  if (!user.userId) {
    await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: connection.organizationId,
      actorId: `scim:${connection.id}`, action: `scim.user_${action}`, targetId: user.id, eventId,
      metadata: { providerId: connection.providerId, status: user.active && !user.deleted ? 'pending_link' : 'suspended', revision: user.revision } }))
    return
  }
  const workspaceIds = await workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, user.userId!)
    const links = await tx.select({ id: organizationWorkspaces.workspaceId }).from(organizationWorkspaces)
      .where(eq(organizationWorkspaces.organizationId, connection.organizationId)).orderBy(asc(organizationWorkspaces.workspaceId))
    const ids = links.map(link => link.id)
    if (ids.length) await tx.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.id, ids)).orderBy(asc(workspaces.id)).for('update')
    const [organization] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, connection.organizationId)).for('update')
    if (!organization) throw new Error('enterprise_organization_missing')
    const suspended = !user.active || user.deleted
    const before = ids.length ? await tx.select({ workspaceId: workspaceMembers.workspaceId, status: workspaceMembers.status }).from(workspaceMembers)
      .where(and(inArray(workspaceMembers.workspaceId, ids), eq(workspaceMembers.userId, user.userId!))) : []
    const profile = user.document
    await tx.insert(organizationMembers).values({ organizationId: connection.organizationId, userId: user.userId!, role: 'member',
      status: suspended ? 'suspended' : 'active', name: profile.displayName || profile.name?.formatted || profile.userName, email: profile.userName })
      .onConflictDoUpdate({ target: [organizationMembers.organizationId, organizationMembers.userId], set: { status: suspended ? 'suspended' : 'active', updatedAt: new Date() } })
    if (suspended && ids.length) await tx.update(workspaceMembers).set({ status: 'suspended' })
      .where(and(inArray(workspaceMembers.workspaceId, ids), eq(workspaceMembers.userId, user.userId!)))
    if (suspended) for (const id of ids) await enqueueMemberLifecycle(tx, id, user.userId!, 'suspend')
    const inserted = await enqueueOrganizationAudit(tx, { organizationId: connection.organizationId, actorId: `scim:${connection.id}`,
      action: `scim.user_${action}`, targetId: user.id, eventId, metadata: { providerId: connection.providerId, status: suspended ? 'suspended' : 'active', revision: user.revision } })
    if (inserted && suspended) for (const membership of before.filter(member => member.status === 'active')) await enqueueWorkspaceAudit(tx, {
      workspaceId: membership.workspaceId, actor: { type: 'system', id: `scim:${connection.id}`, name: 'Directory provisioning' },
      action: 'member.suspended', target: { type: 'user', id: user.userId }, metadata: {},
    })
    return ids
  })
  if (!user.active || user.deleted) {
    if (workspaceIds.length) {
      await pool.query('update personal_access_tokens set "revokedAt"=now() where "userId"=$1 and "workspaceId"=any($2::uuid[]) and "revokedAt" is null', [user.userId, workspaceIds])
      await pool.query(`update run_tokens t set "revokedAt"=now() from agent_runs r where r.id=t."runId" and t."userId"=$1 and r."workspaceId"=any($2::uuid[]) and t."revokedAt" is null`, [user.userId, workspaceIds])
      for (const workspaceId of workspaceIds) await drainMemberLifecycleOutbox(workspaceId, user.userId)
    }
    await pool.query('update enterprise_revocation set "deliveredAt"=now() where "directoryUserId"=$1 and "deliveredAt" is null', [user.id])
  }
}

export async function auditDirectoryGroup(connection: ScimConnection, groupId: string, eventId?: string) {
  await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: connection.organizationId,
    actorId: `scim:${connection.id}`, action: 'scim.group_changed', targetId: groupId, eventId, metadata: { providerId: connection.providerId } }))
}

/** Event-triggered retry by SCIM delivery/management, never a periodic poll. The active=false barrier stays effective until this completes. */
export async function retryEnterpriseRevocations(organizationId: string) {
  const { rows } = await pool.query(`select u.*,c."providerId" from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
    where u."organizationId"=$1 and exists (select 1 from enterprise_revocation r where r."directoryUserId"=u.id and r."deliveredAt" is null)`, [organizationId])
  for (const row of rows) await synchronizeDirectoryUser({ connection: { id: row.connectionId, organizationId, providerId: row.providerId }, user: { ...row, active: false }, action: row.deleted ? 'deleted' : 'suspended' })
  await retryEnterpriseDirectoryOutbox(organizationId)
}

/** Bounded delivery uses the existing maintenance worker and explicit management retry. */
export async function retryEnterpriseDirectoryOutbox(organizationId?: string, force = true) {
  const { rows } = await pool.query<ScimConnection>(`select c.id,c."organizationId",c."providerId" from enterprise_scim_connection c
    where ($1::uuid is null or c."organizationId"=$1) and exists (select 1 from enterprise_scim_outbox o where o."connectionId"=c.id and o."deliveredAt" is null)
    order by c."createdAt",c.id limit 50`, [organizationId ?? null])
  const store = new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup)
  for (const connection of rows) await store.drain(connection, force)
  return rows.length
}
