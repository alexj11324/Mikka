import 'server-only'
import { pool } from '@/lib/db'

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
