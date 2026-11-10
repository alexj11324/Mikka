import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { providerFailureSchema } from '@mikka/protocol/provider-failure'
import { entryKey, type EntrySource, type OrderCandidate, type OrderHarness } from './model-order-plan'
import { runMayUseCredentialSql } from './personal-policy'

type Query = Pick<Pool | PoolClient, 'query'>
type Scope = { ownerId: string; workspaceId: string }
type Candidate = OrderCandidate & { credentialOwnerId?: string }
export type ProviderHealthBlock = { usable: false; reason: 'balance' | 'keyRefused' | 'expired' | 'providerUnavailable'; resetsAt?: string }

const UNAVAILABLE_RETRY_MS = 120_000
export const providerSourceKey = (source: EntrySource) => `${source.kind}:${source.kind === 'api_key' ? source.keyId : source.connectionId}`

/** Only the sanitized runtime contract is evidence of provider health. A
 * model-list response is not evidence that an account can pay for a run. */
export function providerFailureBlock(kind: EntrySource['kind'], failure: unknown, observedAt: Date, now = Date.now()): ProviderHealthBlock | null {
  const parsed = providerFailureSchema.safeParse(failure)
  if (!parsed.success || !Number.isFinite(observedAt.getTime())) return null
  // A native model refusal advances this task's preference only. It does not
  // disprove the credential catalogue or mark a model/source yellow globally.
  if (parsed.data.kind === 'model') return null
  if (parsed.data.kind === 'balance') return { usable: false, reason: 'balance' }
  if (parsed.data.kind === 'auth') return { usable: false, reason: kind === 'api_key' ? 'keyRefused' : 'expired' }
  const retryAt = observedAt.getTime() + UNAVAILABLE_RETRY_MS
  return now < retryAt ? { usable: false, reason: 'providerUnavailable', resetsAt: new Date(retryAt).toISOString() } : null
}

/**
 * Runtime failures persist in agent_runs.report, not process memory. Callers
 * pass only the entries present in orderCandidates for this requester and
 * workspace; a stored order id never grants credential access. The source is
 * the run's frozen key or subscription binding, not its model name.
 *
 * One query returns at most one permanent observation per authorized source
 * and one transient observation per allowed model/harness entry. Success from
 * a newer run clears older permanent failures; transient failures need a
 * newer success on that same entry. Late older completions cannot undo either.
 * Failure evidence requires an explicit provider stop and no cancellation.
 * Key updates are explicit user refresh/replacement; a run started before one
 * cannot poison the refreshed key. Subscription bindings keep their revision.
 */
export async function providerHealthStates(query: Query, scope: Scope, candidates: readonly Candidate[], now = Date.now()): Promise<Map<string, ProviderHealthBlock>> {
  const requested = [...new Map(candidates.map(candidate => [entryKey(candidate), {
    kind: candidate.source.kind,
    id: candidate.source.kind === 'api_key' ? candidate.source.keyId : candidate.source.connectionId,
    ownerId: candidate.credentialOwnerId ?? scope.ownerId,
    harness: candidate.harness, model: candidate.model,
  }])).values()]
  const states = new Map<string, ProviderHealthBlock>()
  if (!requested.length) return states
  const organization = requested.some(source => source.ownerId.startsWith('organization:'))
    ? await (await import('./organization-connections-access')).organizationConnectionAuthority(scope.workspaceId, scope.ownerId) : null
  const { rows } = await query.query<{ kind: EntrySource['kind']; id: string; harness: OrderHarness | null; model: string | null; failure: unknown; observedAt: Date }>(`
    WITH requested AS (
      SELECT * FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::text[]) AS allowed(kind,id,owner,harness,model)
    ), sources AS (
      SELECT DISTINCT requested.kind,requested.id,requested.owner,k."updatedAt" AS "validAfter",NULL::bigint AS epoch
      FROM requested JOIN model_api_keys k ON requested.kind='api_key' AND k.id::text=requested.id AND k."ownerId"=requested.owner
      WHERE to_jsonb(k)->>'revokedAt' IS NULL AND (k."ownerId"=$1 OR (to_jsonb(k)->>'ownership'='organization' AND to_jsonb(k)->>'organizationId'=$8) OR (COALESCE(to_jsonb(k)->>'ownership','personal')='personal' AND
        EXISTS (SELECT 1 FROM model_api_key_shares sh WHERE sh."keyId"=k.id AND sh."workspaceId"::text=$2)
        AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"::text=$2 AND NOT p.subscriptions)))
      UNION ALL
      SELECT DISTINCT requested.kind,requested.id,requested.owner,NULL::timestamptz AS "validAfter",c.epoch
      FROM requested JOIN byos_connections c ON requested.kind='subscription' AND c.id::text=requested.id AND c."ownerId"=requested.owner
      WHERE c.state='connected' AND NOT c.paused AND ${runMayUseCredentialSql('c."ownerId"', '$1', '$2')}
    ), observations AS (
      SELECT s.kind,s.id,r.id AS "runId",r.status,
        CASE WHEN r."stopReason"='provider_failure' AND r."stopRequestedAt" IS NULL THEN r.report->'providerFailure' END AS failure,
        r."agentDefinition"->>'harness' AS harness,
        CASE WHEN s.kind='api_key' THEN r."agentDefinition"->'apiKey'->>'model'
          ELSE r."agentDefinition"->'subscription'->>'modelId' END AS model,
        COALESCE(r."startedAt",r."createdAt") AS "beganAt",COALESCE(r."finishedAt",r."updatedAt") AS "observedAt"
      FROM sources s JOIN agent_runs r ON r."userId"=$1
      WHERE COALESCE(r."agentDefinition"->'executionIdentity'->>'workspaceId',
        (SELECT b."workspaceId"::text FROM bots b WHERE b.id=r."botId" AND b."ownerId"=r."userId"))=$2
        AND (r.status='succeeded' OR (r."stopReason"='provider_failure' AND r."stopRequestedAt" IS NULL
          AND r.report->'providerFailure'->>'kind' IN ('balance','auth','unavailable')
          AND jsonb_typeof(r.report->'providerFailure'->'retryable')='boolean'))
        AND ((s.kind='api_key' AND r."agentDefinition"->'apiKey'->>'keyId'=s.id
          AND s."validAfter"<=COALESCE(r."startedAt",r."createdAt"))
          OR (s.kind='subscription' AND EXISTS (
            SELECT 1 FROM byos_bindings b WHERE b.id::text=r."agentDefinition"->'subscription'->>'bindingId'
              AND b."connectionId"::text=s.id AND b."ownerId"=s.owner AND b."workspaceId"=$2 AND b."connectionRevision"=s.epoch)))
    ), history AS (
      SELECT *,max("beganAt") FILTER (WHERE status='succeeded' AND failure IS NULL) OVER (PARTITION BY kind,id) AS "lastSourceSuccess",
        max("beganAt") FILTER (WHERE status='succeeded' AND failure IS NULL) OVER (PARTITION BY kind,id,harness,model) AS "lastEntrySuccess"
      FROM observations
    ), permanent AS (
      SELECT DISTINCT ON (kind,id) kind,id,NULL::text AS harness,NULL::text AS model,failure,"observedAt" FROM history
      WHERE failure->>'kind' IN ('balance','auth') AND ("lastSourceSuccess" IS NULL OR "beganAt">"lastSourceSuccess")
      ORDER BY kind,id,"beganAt" DESC,"observedAt" DESC,"runId" DESC
    ), transient AS (
      SELECT DISTINCT ON (h.kind,h.id,h.harness,h.model) h.kind,h.id,h.harness,h.model,h.failure,h."observedAt"
      FROM history h JOIN requested r ON r.kind=h.kind AND r.id=h.id AND r.harness=h.harness AND r.model=h.model
      WHERE h.failure->>'kind'='unavailable' AND (h."lastEntrySuccess" IS NULL OR h."beganAt">h."lastEntrySuccess")
      ORDER BY h.kind,h.id,h.harness,h.model,h."beganAt" DESC,h."observedAt" DESC,h."runId" DESC
    )
    SELECT * FROM permanent UNION ALL SELECT * FROM transient`,
  [scope.ownerId, scope.workspaceId, requested.map(source => source.kind), requested.map(source => source.id), requested.map(source => source.ownerId), requested.map(source => source.harness), requested.map(source => source.model), organization?.organizationId ?? null])
  for (const row of rows) {
    const block = providerFailureBlock(row.kind, row.failure, row.observedAt, now)
    if (!block) continue
    if (block.reason === 'providerUnavailable') {
      if (row.harness && row.model) states.set(entryKey({ harness: row.harness, model: row.model,
        source: row.kind === 'api_key' ? { kind: row.kind, keyId: row.id } : { kind: row.kind, connectionId: row.id } }), block)
    } else states.set(`${row.kind}:${row.id}`, block)
  }
  return states
}
