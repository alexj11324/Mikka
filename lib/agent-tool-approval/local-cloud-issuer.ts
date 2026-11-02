import 'server-only'
import type { Pool } from 'pg'
import { localTestAccountsMode } from '@mikka/protocol/local-test-mode'
import { BASE_PATH } from '@/lib/base-path'
import { requestPolicyIssuer } from './policy-distribution'

type Caller = { userId: string; tokenId: string; scopeDeviceId?: string; scopeWorkspaceId?: string }

/** A disposable local API can sit behind a one-run HTTPS test relay. Its
 * operator binds the public issuer in the private test-account schema, never
 * in request headers. A cloud device's current owner/workspace/run/token and
 * lease must still match before either claim or refresh uses that issuer.
 * Production and ordinary local devices retain the existing request issuer. */
export async function requestDevicePolicyIssuer(request: Request, caller: Caller, deviceId: string, runId: string,
  options: { env?: Record<string, string | undefined>; query?: Pick<Pool, 'query'> } = {}) {
  const fallback = requestPolicyIssuer(request)
  if (!localTestAccountsMode(options.env ?? process.env) || caller.scopeDeviceId !== deviceId || !caller.scopeWorkspaceId) return fallback
  const query = options.query ?? (await import('@/lib/db')).pool
  let issuer: string | undefined
  try {
    issuer = (await query.query<{ issuer: string }>(`SELECT relay.issuer FROM mikka_test_accounts.cloud_relays relay
      JOIN devices d ON d.id=relay.device_id AND d."ownerId"=relay.owner_id AND d.kind='cloud' AND d.enabled=true AND d."removedAt" IS NULL
      JOIN agent_runs r ON r.id=relay.run_id AND r."userId"=relay.owner_id AND r."deviceId"=d.id AND r."stopRequestedAt" IS NULL
      JOIN thread_machines m ON m."runId"=r.id AND m."deviceId"=d.id AND m."ownerId"=relay.owner_id AND m."workspaceId"=relay.workspace_id AND m.state IN ('starting','running')
      JOIN device_tokens t ON t.id=$5 AND t."userId"=relay.owner_id AND t."boundDeviceId"=d.id AND t."boundWorkspaceId"=relay.workspace_id
        AND t."revokedAt" IS NULL AND t."expiresAt">now()
      WHERE relay.device_id=$1 AND relay.owner_id=$2 AND relay.workspace_id=$3 AND relay.run_id=$4 AND relay.expires_at>now()
        AND relay.expires_at<=now()+interval '30 minutes'
        AND (r.status='queued' OR (r.status IN ('preparing','running','waiting_input','finishing') AND r."leaseExpiresAt">now()))`,
    [deviceId, caller.userId, caller.scopeWorkspaceId, runId, caller.tokenId])).rows[0]?.issuer
  } catch (error) {
    // Most local test suites do not install this optional harness config.
    if (!['42P01', '3F000'].includes((error as { code?: string }).code ?? '')) throw error
  }
  if (!issuer) return fallback
  const url = new URL(issuer)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || issuer !== `${url.origin}${BASE_PATH}`) throw Error('policyIssuerInvalid')
  return issuer
}
