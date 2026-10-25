import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { QuotaError } from './errors'

export const quotaPolicySchema = z.object({
  windowStart: z.iso.datetime({ offset: true }), windowEnd: z.iso.datetime({ offset: true }),
  budgetUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  concurrencyLimit: z.number().int().min(1).max(10000),
  rateLimit: z.number().int().min(1).max(1000000), rateWindowSeconds: z.number().int().min(1).max(86400),
  resources: z.record(z.string().min(1).max(128), z.object({ units: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), unknownCostApproved: z.literal(true) }).strict()),
  paused: z.boolean(), owners: z.array(z.string().min(1).max(256)).min(1).max(1000),
  override: z.object({ units: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), until: z.iso.datetime({ offset: true }), reason: z.string().trim().min(1).max(1000) }).strict().nullable(),
}).strict().refine(p => Date.parse(p.windowEnd) > Date.parse(p.windowStart) && (!p.override || Date.parse(p.override.until) <= Date.parse(p.windowEnd)), 'Invalid budget window')

export async function configureQuota(pool: Pool, workspaceId: string, actor: string, policy: z.infer<typeof quotaPolicySchema>) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const { rows: [old] } = await c.query('SELECT window_start, window_end FROM quota_tenants WHERE workspace_id=$1 FOR UPDATE', [workspaceId])
    // An active window cannot be slid forward to reset usage. Roll over only after expiry.
    const { rows: [{ now }] } = await c.query('SELECT clock_timestamp() AS now')
    if (old && old.window_end > now && (old.window_start.getTime() !== Date.parse(policy.windowStart) || old.window_end.getTime() !== Date.parse(policy.windowEnd))) throw new QuotaError('quotaWindowImmutable', 409)
    const { rows: [allocation] } = await c.query('SELECT * FROM quota_allocations WHERE workspace_id=$1 FOR SHARE', [workspaceId])
    if (!allocation || allocation.revoked_at || allocation.expires_at <= now || Date.parse(policy.windowEnd) > allocation.expires_at.getTime()
      || BigInt(policy.override?.units ?? policy.budgetUnits) > BigInt(allocation.max_budget_units)
      || BigInt(policy.budgetUnits) > BigInt(allocation.max_budget_units) || policy.concurrencyLimit > allocation.max_concurrency || policy.rateLimit > allocation.max_rate_limit
      || Object.entries(policy.resources).some(([name,rule]) => !Object.hasOwn(allocation.resources,name) || allocation.resources[name].unknownCostApproved !== true || allocation.resources[name].units !== rule.units)) {
      throw new QuotaError('quotaAllocationExceeded', 403)
    }
    if (Date.parse(policy.windowEnd) <= now.getTime() || Date.parse(policy.windowStart) > now.getTime() || (policy.override && Date.parse(policy.override.until) <= now.getTime())) throw new QuotaError('quotaInvalidWindow', 400)
    // Keep all owner locks in a stable order; bindings cannot be reassigned through this API.
    for (const owner of [...new Set(policy.owners)].sort()) {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`quota-owner:${owner}`])
      const { rows: [bound] } = await c.query('SELECT workspace_id FROM quota_owners WHERE owner_id=$1', [owner])
      if (bound && bound.workspace_id !== workspaceId) throw new QuotaError('quotaOwnerAlreadyBound', 409)
    }
    await c.query(`INSERT INTO quota_tenants (workspace_id,window_start,window_end,budget_units,concurrency_limit,rate_limit,rate_window_seconds,resources,paused,override_units,override_until,override_by,override_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(workspace_id) DO UPDATE SET
      window_start=excluded.window_start,window_end=excluded.window_end,budget_units=excluded.budget_units,concurrency_limit=excluded.concurrency_limit,
      rate_limit=excluded.rate_limit,rate_window_seconds=excluded.rate_window_seconds,resources=excluded.resources,paused=excluded.paused,
      override_units=excluded.override_units,override_until=excluded.override_until,override_by=excluded.override_by,override_reason=excluded.override_reason`,
    [workspaceId,policy.windowStart,policy.windowEnd,policy.budgetUnits,policy.concurrencyLimit,policy.rateLimit,policy.rateWindowSeconds,policy.resources,policy.paused,
      policy.override?.units ?? null,policy.override?.until ?? null,policy.override ? actor : null,policy.override?.reason ?? null])
    for (const owner of [...new Set(policy.owners)].sort()) await c.query('INSERT INTO quota_owners(owner_id,workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [owner,workspaceId])
    await c.query('INSERT INTO quota_policy_events(id,workspace_id,actor,policy) VALUES ($1,$2,$3,$4)', [randomUUID(),workspaceId,actor,policy])
    await c.query('COMMIT')
  } catch (error) { await c.query('ROLLBACK'); throw error }
  finally { c.release() }
}
