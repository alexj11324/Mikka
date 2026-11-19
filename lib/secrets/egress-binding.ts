import 'server-only'
import { pool } from '@/lib/db'
import { LEASED_RUN_STATUSES } from '@/lib/run-retry'
import { deviceSessionOpenSql } from '@/lib/device-presence'
import type { EgressCapabilityClaims } from './egress-capability'

/**
 * Whether the run a Task Secret capability was issued for still holds it, read
 * at every use (decision 2026-11-17-2215): the run is active (not stopped, its
 * lease not ended), it is bound to the same owner, workspace, device, claim
 * credential and attempt as the capability, the credential is not revoked, the
 * device's session is open, and the owner is still an active member of the
 * workspace with current Enterprise machine-credential authority. Ending a
 * lease (disconnect, stop, revocation, a policy or Secret change) therefore
 * refuses the next request at once. No secret is read here.
 */
export async function egressBindingActive(claims: Pick<EgressCapabilityClaims, 'ownerId' | 'workspaceId' | 'runId' | 'deviceId' | 'deviceTokenId' | 'attempt'>): Promise<boolean> {
  const { rows: [run] } = await pool.query<{ boundDeviceId: string | null; boundWorkspaceId: string | null; currentTokenId: string | null }>(`SELECT t."boundDeviceId", t."boundWorkspaceId",
      CASE WHEN t."boundDeviceId" IS NULL THEN t.id ELSE (SELECT c.id FROM device_tokens c WHERE c."userId"=r."userId" AND c."boundDeviceId"=t."boundDeviceId"
        AND c."boundWorkspaceId"=t."boundWorkspaceId" AND c."revokedAt" IS NULL AND c."expiresAt">clock_timestamp() ORDER BY c."expiresAt" DESC LIMIT 1) END AS "currentTokenId"
    FROM agent_runs r
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled AND d."removedAt" IS NULL
      JOIN device_tokens t ON t.id=r."deviceTokenId" AND t."userId"=r."userId" AND t."revokedAt" IS NULL
    WHERE r.id::text=$1 AND r."userId"=$2 AND r."deviceId"::text=$3 AND r."deviceTokenId"::text=$4 AND r.attempt=$5
      AND r."workspaceId"::text IS NOT DISTINCT FROM $6::text
      AND r.status=ANY($7::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">clock_timestamp()
      AND ${deviceSessionOpenSql('d')}
      AND NOT EXISTS (SELECT 1 FROM device_credential_revocations v WHERE v."tokenId"=t.id)
    LIMIT 1`, [claims.runId, claims.ownerId, claims.deviceId, claims.deviceTokenId, claims.attempt, claims.workspaceId, [...LEASED_RUN_STATUSES]])
  if (!run?.currentTokenId) return false
  if (!claims.workspaceId) return true
  // The checks the retired renewal made on the credential's behalf: membership,
  // then Enterprise machine-credential and directory authority for that credential.
  const [{ executionMembersActive }, { enterpriseWorkspaceAllowed }, { deviceRequestCaller }] = await Promise.all([
    import('@/lib/execution-identity'), import('@/lib/enterprise/access'), import('@/lib/device-request-context')])
  if (!await executionMembersActive(claims.workspaceId, [claims.ownerId])) return false
  const caller = run.boundDeviceId && run.boundWorkspaceId
    ? { userId: claims.ownerId, tokenId: run.currentTokenId, scopeDeviceId: run.boundDeviceId, scopeWorkspaceId: run.boundWorkspaceId }
    : { userId: claims.ownerId, tokenId: run.currentTokenId }
  const workspaceId = claims.workspaceId
  return deviceRequestCaller.run(caller, () => enterpriseWorkspaceAllowed(claims.ownerId, workspaceId))
}
