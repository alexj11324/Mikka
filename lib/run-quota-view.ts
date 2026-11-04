import 'server-only'
import { pool } from '@/lib/db'
import { modelFallbackRecordSchema, projectModelFallback, type ThreadModelFallbackView } from './run-model-fallback-view'
import { factoryEventId } from './factory/event-id'

/**
 * What an open thread shows about its subscription's quota (lib/run-quota.ts):
 * each run in its chain that went on on the person's API key, and whether its
 * live run is paused on the quota. Read for the owner only.
 */
export interface ThreadQuotaView {
  switched: { runId: string; subscription: 'claude' | 'codex'; plan: string | null; key: { provider: string; name: string | null; model: string } }[]
  paused: { runId: string; subscription: 'claude' | 'codex'; plan: string | null; resetsAt: string | null; keyReady: boolean } | null
}

const provider = (value: unknown): 'claude' | 'codex' => value === 'codex' ? 'codex' : 'claude'

export async function threadQuotaView(userId: string, runIds: readonly string[], liveRunId: string): Promise<ThreadQuotaView> {
  const { rows: events } = await pool.query<{ kind: string; runId: string; payload: Record<string, unknown> }>(
    `SELECT kind,"runId",payload FROM coordinator_events WHERE "userId"=$1 AND "runId"=ANY($2::uuid[]) AND kind IN ('run_credential_switched','run_quota_paused') ORDER BY "createdAt"`,
    [userId, runIds])
  const connections = [...new Set(events.flatMap(event => {
    const from = event.payload.from as { connectionId?: unknown } | undefined
    const id = event.kind === 'run_credential_switched' ? from?.connectionId : event.payload.connectionId
    return typeof id === 'string' ? [id] : []
  }))]
  const plans = new Map(connections.length ? (await pool.query<{ id: string; plan: string | null }>(
    `SELECT id::text AS id,quota->>'plan' AS plan FROM byos_connections WHERE "ownerId"=$1 AND id::text=ANY($2::text[])`, [userId, connections])).rows.map(row => [row.id, row.plan]) : [])
  const planOf = (id: unknown) => typeof id === 'string' ? plans.get(id) ?? null : null
  const switched = events.filter(event => event.kind === 'run_credential_switched').map(event => {
    const from = (event.payload.from ?? {}) as { provider?: unknown; connectionId?: unknown }
    const to = (event.payload.to ?? {}) as { provider?: unknown; name?: unknown; model?: unknown }
    return {
      runId: event.runId, subscription: provider(from.provider), plan: planOf(from.connectionId),
      key: { provider: String(to.provider ?? ''), name: typeof to.name === 'string' ? to.name : null, model: String(to.model ?? '') },
    }
  })
  const { agentRuns } = await import('@/lib/db/schema')
  const { db } = await import('@/lib/db')
  const { and, eq } = await import('drizzle-orm')
  const [live] = await db.select().from(agentRuns).where(and(eq(agentRuns.id, liveRunId), eq(agentRuns.userId, userId))).limit(1)
  let paused: ThreadQuotaView['paused'] = null
  if (live?.status === 'paused' && live.pauseReason === 'quota_exhausted') {
    const event = events.findLast(item => item.kind === 'run_quota_paused' && item.runId === live.id)
    const { quotaKeyReady } = await import('@/lib/run-quota')
    paused = {
      runId: live.id, subscription: provider(event?.payload.provider ?? (live.agentDefinition?.harness === 'codex' ? 'codex' : 'claude')),
      plan: planOf(event?.payload.connectionId), resetsAt: live.quotaResetsAt?.toISOString() ?? null,
      keyReady: await quotaKeyReady(pool, live),
    }
  }
  return { switched, paused }
}

/** Runtime-provider recovery is a host-owned run receipt, not the legacy
 * subscription-quota event. The caller obtained these ids from readRunChain
 * for this owner; the query and projection retain both boundaries. */
export async function threadModelFallbackState(userId: string, runIds: readonly string[], liveRunId?: string): Promise<{ notices: ThreadModelFallbackView[]; pending: boolean }> {
  if (!runIds.length) return { notices: [], pending: false }
  const { rows } = await pool.query<{ id: string; status: string; stopReason: string | null; stopRequestedAt: Date | null; record: unknown; failure: unknown }>(
    `SELECT id,status,"stopReason","stopRequestedAt",report->'modelFallback' AS record,report->'providerFailure' AS failure FROM agent_runs
      WHERE "userId"=$1 AND id=ANY($2::uuid[]) ORDER BY "createdAt",id`, [userId, runIds])
  const chain = new Set(rows.map(row => row.id))
  // Independent Factory checks clear retryOf when adopted. Their host event,
  // task attempts and frozen digest prove the switch without changing the
  // conversation's send/stop chain or treating a caller-supplied id as access.
  const receipts = rows.flatMap(row => {
    const parsed = modelFallbackRecordSchema.safeParse(row.record)
    const receipt = parsed.success ? parsed.data : null
    return receipt?.state === 'switched' && receipt.retryRunId && receipt.nextDefinitionDigest && !chain.has(receipt.retryRunId)
      ? [{ sourceId: row.id, childId: receipt.retryRunId, digest: receipt.nextDefinitionDigest, eventId: factoryEventId('provider-check-continuation', row.id) }] : []
  })
  const independent = new Map(receipts.length ? (await pool.query<{ sourceId: string; childId: string }>(`
    WITH wanted AS (
      SELECT * FROM unnest($2::uuid[],$3::uuid[],$4::text[],$5::uuid[]) AS receipt("sourceId","childId",digest,"eventId")
    )
    SELECT source.id AS "sourceId",child.id AS "childId" FROM wanted w
    JOIN agent_runs source ON source.id=w."sourceId" AND source."userId"=$1
    JOIN agent_runs child ON child.id=w."childId" AND child."userId"=source."userId" AND child."issueId"=source."issueId"
    JOIN factory_attempts prior ON prior."runId"=source.id AND prior.stage IN ('review','verify','monitor')
    JOIN factory_attempts adopted ON adopted."runId"=child.id AND adopted."taskId"=prior."taskId" AND adopted.stage=prior.stage
      AND adopted."candidateId" IS NOT DISTINCT FROM prior."candidateId"
    JOIN factory_tasks task ON task.id=prior."taskId" AND task."userId"=source."userId" AND task."issueId"=source."issueId"
    JOIN factory_events event ON event."taskId"=task.id AND event."eventId"=w."eventId"
      AND event.request->>'priorRunId'=source.id::text AND event.result->>'runId'=child.id::text
    WHERE child."retryOf" IS NULL AND source."stopReason"='provider_failure'
      AND child."agentDefinition"->>'definitionDigest'=w.digest
      AND source.report->'modelFallback'->>'state'='switched'
      AND source.report->'modelFallback'->>'retryRunId'=child.id::text
      AND source.report->'modelFallback'->>'nextDefinitionDigest'=w.digest`,
  [userId, receipts.map(item => item.sourceId), receipts.map(item => item.childId), receipts.map(item => item.digest), receipts.map(item => item.eventId)])).rows
    .map(row => [row.sourceId, row.childId]) : [])
  const notices = rows.flatMap(row => {
    const child = independent.get(row.id)
    const view = projectModelFallback(row.id, row.record, row.failure, child ? new Set([...chain, child]) : chain)
    return view ? [view] : []
  })
  const pending = rows.some(row => {
    if (row.id !== liveRunId || row.status !== 'failed' || row.stopReason !== 'provider_failure' || row.stopRequestedAt) return false
    const receipt = modelFallbackRecordSchema.safeParse(row.record)
    return receipt.success && receipt.data.state === 'pending'
  })
  return { notices, pending }
}

export async function threadModelFallbackView(userId: string, runIds: readonly string[]): Promise<ThreadModelFallbackView[]> {
  return (await threadModelFallbackState(userId, runIds)).notices
}
