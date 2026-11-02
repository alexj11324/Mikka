import type { Pool, PoolClient } from 'pg'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * Withdrawing an API key stops the runs it was handed to, as
 * stopRunsUsingSubscriptions does for subscriptions (orchestration.md § 2):
 * deleting the key stops every run on it; the owner leaving a workspace stops
 * that workspace's runs on their keys; turning the key's 分享给团队成员 off, or
 * the admin's 允许成员使用个人订阅和 API Key going off, stops only other
 * members' runs (othersOnly): a person's own keys always run their own bots
 * (decision 2026-11-01-2240). Un-sharing subscriptions no longer touches keys.
 * The daemon then wipes the injected key.
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
