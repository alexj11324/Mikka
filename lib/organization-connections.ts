import 'server-only'
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { pool } from './db'
import { workspaceDb } from './workspace-db'
import { organizationResourcePolicies, organizationPolicyOutbox } from './db/governance-schema'
import { requireOrganizationAdmin, getOrganizationWorkspaceIds } from './governance/organizations'
import { enqueueOrganizationAudit } from './governance/audit'
import { GovernanceError } from './governance/errors'
import { commitIdentityChange, deliverIdentityAudits } from './enterprise/audit-outbox'
import { addApiKey, addApiKeyInput } from './model-api-keys'
import { stopRunsUsingApiKeys } from './model-api-key-runs'
import { organizationCredentialOwner, organizationModelPolicySchema, readModelPolicy } from './organization-model-policy'
import { retryOrganizationPolicyOutbox } from './governance/resource-policy'
import { armDueTimerAfterCommit } from './due-timer'
import type { ApiKeyView } from './model-api-key-providers'
import type { OrganizationAuditInput } from './governance/audit-events'

export const organizationConnectionInput = z.object({
  connectionKind: z.enum(['api_key', 'gateway', 'custom_endpoint']), credential: addApiKeyInput,
}).strict().refine(value => value.connectionKind === 'api_key' || value.credential.provider === 'custom', 'custom_endpoint_required')

/** Administrative views contain provider metadata and a suffix, never the sealed credential. */
export async function readOrganizationConnections(organizationId: string, actorId: string) {
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    const { rows } = await pool.query<ApiKeyView>(`SELECT id,provider,name,"baseUrl",protocol,last4,models,"modelsError","responsesApi",
      ownership,"organizationId","connectionKind",revision,"revokedAt" FROM model_api_keys
      WHERE "organizationId"=$1 AND ownership='organization' ORDER BY "createdAt",id`, [organizationId])
    const [policy] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, organizationId)).orderBy(asc(organizationResourcePolicies.organizationId))
    return { connections: rows, modelPolicy: readModelPolicy(policy?.modelPolicy), policyRevision: policy?.revision ?? 0 }
  })
}

/** Reuses the existing credential vault and durable APP -> WS audit outbox. */
export async function saveOrganizationConnection(organizationId: string, actorId: string, input: unknown, connectionId?: string) {
  const value = organizationConnectionInput.parse(input)
  if (connectionId) z.uuid().parse(connectionId)
  const saved = await workspaceDb.transaction(async authority => {
    await requireOrganizationAdmin(authority, organizationId, actorId)
    const audit: OrganizationAuditInput = { organizationId, actorId,
      action: connectionId ? 'organization.connection_rotated' : 'organization.connection_created', targetId: connectionId,
      metadata: { providerId: value.credential.provider } }
    return commitIdentityChange(audit, async tx => {
      // Same provider preset is a rotation of the same organization resource; no personal credential is copied or transferred.
      const existing = value.credential.provider !== 'custom' ? await tx.query('SELECT 1 FROM model_api_keys WHERE "ownerId"=$1 AND provider=$2', [organizationCredentialOwner(organizationId), value.credential.provider]) : null
      if (existing?.rowCount) audit.action = 'organization.connection_rotated'
      const key = await addApiKey(tx, organizationCredentialOwner(organizationId), value.credential, {
        organization: { id: organizationId, actorId, kind: value.connectionKind }, connectionId,
      })
      audit.targetId = key.id
      audit.metadata = { ...audit.metadata, revision: key.revision ?? 1 }
      return key
    }, { deferDelivery: true })
  })
  await deliverIdentityAudits(organizationId)
  return saved
}

/** Soft revoke preserves the resource and audit history, and interrupts issued AND queued runs. */
export async function revokeOrganizationConnection(organizationId: string, actorId: string, connectionId: string) {
  z.uuid().parse(connectionId)
  await workspaceDb.transaction(async authority => {
    await requireOrganizationAdmin(authority, organizationId, actorId)
    await commitIdentityChange({ organizationId, actorId, action: 'organization.connection_revoked', targetId: connectionId }, async tx => {
      const found = await tx.query('SELECT 1 FROM model_api_keys WHERE id=$1 AND "organizationId"=$2 AND ownership=\'organization\' FOR UPDATE', [connectionId, organizationId])
      if (!found.rowCount) throw new GovernanceError('not_found')
      await tx.query(`UPDATE model_api_keys SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()),ciphertext='',iv='',"updatedAt"=clock_timestamp() WHERE id=$1`, [connectionId])
      await stopRunsUsingApiKeys(tx, { keyId: connectionId, ownerId: organizationCredentialOwner(organizationId) })
    }, { deferDelivery: true })
  })
  await deliverIdentityAudits(organizationId)
  return { revoked: true }
}

/** Per-model rules and source order extend the existing Organization policy, without purchasing a plan. */
export async function configureOrganizationModels(organizationId: string, actorId: string, input: unknown) {
  const value = organizationModelPolicySchema.parse(input)
  await workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    const connectionIds = [...new Set(Object.values(value.models).flatMap(rule => rule.connectionId ? [rule.connectionId] : []))]
    if (connectionIds.length) {
      const keys = await pool.query<{ id: string }>('SELECT id FROM model_api_keys WHERE "organizationId"=$1 AND ownership=\'organization\' AND "revokedAt" IS NULL AND id=ANY($2::uuid[])', [organizationId, connectionIds])
      if (keys.rows.length !== connectionIds.length) throw new GovernanceError('invalid_request')
    }
    const [previous] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, organizationId))
    const revision = (previous?.revision ?? 0) + 1
    await tx.insert(organizationResourcePolicies).values({ organizationId, modelPolicy: value, revision })
      .onConflictDoUpdate({ target: organizationResourcePolicies.organizationId, set: { modelPolicy: value, revision, updatedAt: new Date() } })
    await enqueueOrganizationAudit(tx, { organizationId, actorId, action: 'organization.model_policy_changed', metadata: { revision } })
    if (JSON.stringify(readModelPolicy(previous?.modelPolicy).models) !== JSON.stringify(value.models)) {
      await tx.insert(organizationPolicyOutbox).values({ id: randomUUID(), organizationId, workspaceIds: await getOrganizationWorkspaceIds(tx, organizationId),
        changes: { modelCredentials: false, mcp: false, modelProviders: false, modelPolicy: true } })
      armDueTimerAfterCommit(tx, 'audit-retention')
    }
  })
  await retryOrganizationPolicyOutbox(organizationId)
  return readOrganizationConnections(organizationId, actorId)
}
