import type { Pool, PoolClient } from 'pg'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * Withdrawing an API key stops the runs it was handed to, as
 * stopRunsUsingSubscriptions does for subscriptions (orchestration.md § 2):
 * deleting the key, turning its 分享给团队成员 off (othersOnly), un-sharing
 * the owner's credentials in a workspace, the owner leaving it, or the admin
 * switch going off. The daemon then wipes the injected key.
 */
export async function stopRunsUsingApiKeys(query: Query, scope: { keyId?: string; ownerId?: string; workspaceId?: string; othersOnly?: boolean }) {
  if (!scope.keyId && !scope.workspaceId) throw new Error('stopRunsUsingApiKeys needs a key or a workspace')
  const { rowCount } = await query.query(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM model_api_key_runs m JOIN model_api_keys k ON k.id=m."keyId"
    WHERE m."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','waiting_input','finishing')
      AND ($1::uuid IS NULL OR k.id=$1) AND ($2::text IS NULL OR k."ownerId"=$2) AND ($3::text IS NULL OR m."workspaceId"::text=$3)
      AND (NOT $4::boolean OR r."userId"<>k."ownerId")`,
  [scope.keyId ?? null, scope.ownerId ?? null, scope.workspaceId ?? null, scope.othersOnly ?? false])
  return rowCount ?? 0
}
