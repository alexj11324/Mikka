import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { enqueueWorkspaceAudit } from '@/lib/audit/delivery'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'
import { workspaceListChanged } from '@/lib/live/lists'
import { requireWorkspace, type WorkspaceTransaction } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { GovernanceError } from './errors'

const name = z.string().trim().min(1).max(100)
const createInput = z.object({ requestId: z.uuid(), name }).strict()
const changeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), revision: z.number().int().positive(), name }).strict(),
  z.object({ action: z.enum(['disable', 'restore']), revision: z.number().int().positive() }).strict(),
])
type ServiceIdentity = { id: string; workspaceId: string; name: string; enabled: boolean; revision: number }
type AuditAction = 'created' | 'renamed' | 'disabled' | 'restored'
const publicColumns = sql`id, "workspaceId", name, enabled, revision`

function asAdmin<T>(workspaceId: string, actor: EnterpriseReader, work: (tx: WorkspaceTransaction, actorName: string) => Promise<T>) {
  return workspaceDb.transaction(async tx => {
    const { workspace, membership } = await requireWorkspace(tx, workspaceId, actor.id, true, actor[enterprisePrincipal])
    if (workspace.kind !== 'team') throw new GovernanceError('personal_workspace')
    return work(tx, membership.name)
  })
}

async function recordChange(tx: WorkspaceTransaction, identity: ServiceIdentity, actorId: string, actorName: string, action: AuditAction) {
  await enqueueWorkspaceAudit(tx, {
    workspaceId: identity.workspaceId, actor: { type: 'user', id: actorId, name: actorName },
    action: `service_identity.${action}`, target: { type: 'service_identity', id: identity.id },
  })
  await workspaceListChanged(tx, identity.workspaceId, ['workspace_settings'])
}

export function listServiceIdentities(workspaceId: string, actor: EnterpriseReader, after: string | null) {
  const cursor = z.uuid().nullable().parse(after)
  return asAdmin(workspaceId, actor, async tx => {
    const { rows } = await tx.execute<ServiceIdentity>(sql`SELECT ${publicColumns} FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid) ORDER BY id LIMIT 101`)
    const identities = rows.slice(0, 100)
    return { identities, nextCursor: rows.length > 100 ? identities[99].id : null }
  })
}

export function getServiceIdentity(workspaceId: string, actor: EnterpriseReader, identityId: string) {
  z.uuid().parse(identityId)
  return asAdmin(workspaceId, actor, async tx => {
    const { rows: [identity] } = await tx.execute<ServiceIdentity>(sql`SELECT ${publicColumns} FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${identityId}::uuid`)
    if (!identity) throw new GovernanceError('not_found')
    return identity
  })
}

export function createServiceIdentity(workspaceId: string, actor: EnterpriseReader, input: unknown) {
  const value = createInput.parse(input)
  return asAdmin(workspaceId, actor, async (tx, actorName) => {
    const { rows: [created] } = await tx.execute<ServiceIdentity>(sql`INSERT INTO mikka_workspace_service_identities
      ("workspaceId", name, "createdBy", "requestId", "initialName")
      VALUES (${workspaceId}::uuid, ${value.name}, ${actor.id}, ${value.requestId}::uuid, ${value.name})
      ON CONFLICT ("workspaceId", "createdBy", "requestId") DO NOTHING RETURNING ${publicColumns}`)
    if (created) {
      await recordChange(tx, created, actor.id, actorName, 'created')
      return created
    }
    const { rows: [existing] } = await tx.execute<ServiceIdentity>(sql`SELECT ${publicColumns} FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND "createdBy"=${actor.id} AND "requestId"=${value.requestId}::uuid
        AND "initialName"=${value.name}`)
    if (!existing) throw new GovernanceError('service_identity_request_reused')
    return existing
  })
}

export function updateServiceIdentity(workspaceId: string, actor: EnterpriseReader, identityId: string, input: unknown) {
  z.uuid().parse(identityId)
  const change = changeInput.parse(input)
  return asAdmin(workspaceId, actor, async (tx, actorName) => {
    const { rows: [current] } = await tx.execute<ServiceIdentity>(sql`SELECT ${publicColumns} FROM mikka_workspace_service_identities
      WHERE "workspaceId"=${workspaceId}::uuid AND id=${identityId}::uuid FOR UPDATE`)
    if (!current) throw new GovernanceError('not_found')
    if (current.revision !== change.revision) throw new GovernanceError('service_identity_changed')
    const name = change.action === 'rename' ? change.name : current.name
    const enabled = change.action === 'rename' ? current.enabled : change.action === 'restore'
    if (name === current.name && enabled === current.enabled) return current
    const { rows: [updated] } = await tx.execute<ServiceIdentity>(sql`UPDATE mikka_workspace_service_identities
      SET name=${name}, enabled=${enabled}, revision=revision+1 WHERE "workspaceId"=${workspaceId}::uuid AND id=${identityId}::uuid
      RETURNING ${publicColumns}`)
    await recordChange(tx, updated, actor.id, actorName, change.action === 'rename' ? 'renamed' : enabled ? 'restored' : 'disabled')
    return updated
  })
}
