import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { enterprisePrincipal, type EnterpriseReader } from '@/lib/enterprise/principal'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceListChanged } from '@/lib/live/lists'
import { workspaceDb } from '@/lib/workspace-db'
import { enqueueOrganizationAudit } from './audit'
import { GovernanceError } from './errors'
import { requireOrganizationAdmin } from './organizations'

type Key = {
  id: string; name: string | null; workspaceId: string; serviceIdentityId: string
  serviceIdentityName: string; expiresAt: Date | string | null
}
const renameInput = z.object({ name: z.string().trim().min(1).max(100) }).strict()

// A directory entry belongs to the current issue of the key on this original attachment.
// Explicitly select public columns. Neither the secret nor its verification digest leaves the store.
function visibleKeys(organizationId: string, userId: string) {
  return sql`FROM mikka_service_key_organization_bindings b
    JOIN mikka_workspace_service_identities i ON i.id=b."identityId" AND i."workspaceId"=b."workspaceId"
      AND i.enabled AND i."credentialHash"=b."credentialHash"
    JOIN mikka_workspaces w ON w.id=b."workspaceId" AND w.kind='team'
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=${userId}
      AND m.status='active' AND m.role='admin'
    WHERE b."organizationId"=${organizationId}::uuid`
}

export function listOrganizationApiKeys(organizationId: string, userId: string, after: string | null) {
  const cursor = z.uuid().nullable().parse(after)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const { rows } = await tx.execute<Key>(sql`SELECT b."keyId" AS id,b.name,b."workspaceId",
      i.id AS "serviceIdentityId",i.name AS "serviceIdentityName",i."credentialExpiresAt" AS "expiresAt"
      ${visibleKeys(organizationId, userId)}
      AND (${cursor}::uuid IS NULL OR b."keyId">${cursor}::uuid) ORDER BY b."keyId" LIMIT 101`)
    const keys = rows.slice(0, 100).map(row => ({
      ...row, expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString(),
    }))
    return { keys, nextCursor: rows.length > 100 ? keys[99].id : null }
  })
}

export function renameOrganizationApiKey(organizationId: string, actor: EnterpriseReader, rawId: string, input: unknown) {
  const keyId = z.uuid().parse(rawId)
  const { name } = renameInput.parse(input)
  return workspaceDb.transaction(async tx => {
    const { rows: [key] } = await tx.execute<{ workspaceId: string }>(sql`SELECT b."workspaceId"
      ${visibleKeys(organizationId, actor.id)} AND b."keyId"=${keyId}::uuid`)
    // Match the workspace-then-organization ordering used by issuance and detachment.
    if (key) await requireWorkspace(tx, key.workspaceId, actor.id, true, actor[enterprisePrincipal])
    await requireOrganizationAdmin(tx, organizationId, actor.id)
    if (!key) throw new GovernanceError('not_found')
    const { rows: [renamed] } = await tx.execute<{ id: string; name: string }>(sql`UPDATE mikka_service_key_organization_bindings
      SET name=${name} WHERE "keyId"=${keyId}::uuid AND "organizationId"=${organizationId}::uuid
        AND "workspaceId"=${key.workspaceId}::uuid RETURNING "keyId" AS id,name`)
    if (!renamed) throw new GovernanceError('not_found')
    // Organization audit readers may have no membership in the credential's Workspace.
    await enqueueOrganizationAudit(tx, { organizationId, actorId: actor.id, action: 'organization.api_key_renamed' })
    await workspaceListChanged(tx, key.workspaceId, ['workspace_settings'])
    return renamed
  })
}
