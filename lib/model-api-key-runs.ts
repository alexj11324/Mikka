import type { Pool, PoolClient } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { armDueTimerAfterCommit } from '@/lib/due-timer'

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
  const { rowCount, rows } = await query.query<{ id: string }>(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM model_api_keys k
    WHERE r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
      AND ($1::uuid IS NULL OR k.id=$1) AND ($2::text IS NULL OR k."ownerId"=$2)
      AND ((to_jsonb(r)#>>'{agentDefinition,apiKey,keyId}'=k.id::text AND ($3::text IS NULL OR to_jsonb(r)->>'workspaceId'=$3))
        OR EXISTS (SELECT 1 FROM model_api_key_runs m WHERE m."runId"=r.id AND m."keyId"=k.id AND ($3::text IS NULL OR m."workspaceId"::text=$3)))
      AND (NOT $4::boolean OR r."userId"<>k."ownerId") RETURNING r.id`,
  [scope.keyId ?? null, scope.ownerId ?? null, scope.workspaceId ?? null, scope.othersOnly ?? false])
  for (const { id } of rows) { await runListChanged(query, id); await runChanged(query, id) }
  runControlChanged(query, { runIds: rows.map(row => row.id) })
  // Their leases ended now: if the daemon never reports the stop, run recovery reclaims them (#1212).
  if (rows.length) armDueTimerAfterCommit(query, 'run-recovery')
  return rowCount ?? 0
}
