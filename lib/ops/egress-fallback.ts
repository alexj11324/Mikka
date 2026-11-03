import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { publish, run } from '../../scripts/ops/egress-monitor.mjs'

type Claim = { claim: string; nextAttemptAt: number; lastAttemptedAt: number; lastSucceededAt?: number }
type Options = { neonToken?: string; posthogKey?: string; now?: () => number; collect?: () => Promise<void> }

// Share the existing observation writer's short state lock. No external request
// runs under this lock, and only our dedicated JSON key is ever changed.
async function stateTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka-ops-monitor',0))")
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch {
    await client.query('ROLLBACK').catch(() => {})
    throw Error('__providerEgressCollectorStateUnavailable')
  } finally { client.release() }
}

/** Durable quarter-hour provider coverage from the existing minute cron. */
export async function collectProviderEgress(pool: Pool, options: Options = {}) {
  const now = options.now ?? Date.now
  let claim: Claim | undefined
  try {
    claim = await stateTransaction(pool, async client => {
      const row = (await client.query('SELECT id,state->\'__providerEgressCollector\' AS collector FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1')).rows[0]
      // The independent ordinary monitor creates the first observation. Retry on
      // the next minute rather than fabricating an unrelated observation here.
      if (!row) return undefined
      const at = now(), previous = row.collector as Claim | null
      if (previous?.nextAttemptAt && previous.nextAttemptAt > at) return undefined
      const next = { ...previous, claim: randomUUID(), lastAttemptedAt: at, nextAttemptAt: at + 120_000 }
      await client.query("UPDATE ops_monitor_observations SET state=jsonb_set(state,'{__providerEgressCollector}',$2::jsonb) WHERE id=$1", [row.id, JSON.stringify(next)])
      return next
    })
    if (!claim) return { status: 'not_due' as const }
    let succeeded = false
    try {
      if (options.collect) await options.collect()
      else {
        const report = await run({ vercelToken: undefined, neonToken: options.neonToken, providerOnly: true })
        // Publish failure health too; never replace missing supplier data with 0.
        await publish(report, options.posthogKey)
        if (report.reasons.length) throw Error('egressProviderUnavailable')
      }
      succeeded = true
    } catch { /* Persist only a status; never a provider response or credential. */ }
    await stateTransaction(pool, async client => {
      const at = now(), next = { ...claim, nextAttemptAt: at + (succeeded ? 900_000 : 60_000),
        ...(succeeded ? { lastSucceededAt: at } : { lastFailedAt: at }) }
      // The ordinary monitor may have appended a newer row while requests ran.
      // Match our lease and merge only this key on the current row.
      await client.query(`UPDATE ops_monitor_observations SET state=jsonb_set(state,'{__providerEgressCollector}',$2::jsonb)
        WHERE id=(SELECT id FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1)
        AND state->'__providerEgressCollector'->>'claim'=$1`, [claim!.claim, JSON.stringify(next)])
    })
    return { status: succeeded ? 'collected' as const : 'failed' as const }
  } catch { return { status: 'failed' as const } }
}
