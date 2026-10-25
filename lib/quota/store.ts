import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { QuotaError } from './errors'

export type QuotaAuthorization = (ownerId: string, workspaceId: string) => Promise<boolean>
export type Reservation = { id: string; owner_id: string; workspace_id: string; resource: string; state: string; units: string; expires_at: Date; fingerprint: string }
export type QuotaRequest = { ownerId: string; key: string; resource: string; binding: unknown; leaseMs?: number }
const MAX_LEASE_MS = 300_000

// Stable serialization: property ordering must not turn a retry into another operation.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export class QuotaStore {
  constructor(readonly pool: Pool, readonly authorize: QuotaAuthorization) {}

  private async transaction<T>(ownerId: string, action: (client: PoolClient, tenant: Record<string, any>, now: Date) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // All mutations use tenant -> reservation order, including expiry, completion,
      // backoff and renewal. Re-read authorization and wall time AFTER waiting.
      const { rows: [tenant] } = await client.query(`SELECT t.* FROM quota_tenants t JOIN quota_owners o USING(workspace_id) WHERE o.owner_id=$1 FOR UPDATE OF t`, [ownerId])
      if (!tenant) throw new QuotaError('quotaNotConfigured', 503, 60)
      if (!await this.authorize(ownerId, tenant.workspace_id)) throw new QuotaError('quotaAccessDenied', 403)
      const { rows: [allocation] } = await client.query('SELECT * FROM quota_allocations WHERE workspace_id=$1 FOR SHARE', [tenant.workspace_id])
      const { rows: [{ now }] } = await client.query('SELECT clock_timestamp() AS now')
      tenant.allocation = allocation
      const result = await action(client, tenant, now)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  private checkPolicy(tenant: Record<string, any>, resource: string, now: Date) {
    const allocation = tenant.allocation
    if (!allocation || allocation.revoked_at || allocation.expires_at <= now) throw new QuotaError('quotaAllocationUnavailable', 403, 60)
    if (tenant.rate_window_seconds !== allocation.rate_window_seconds) throw new QuotaError('quotaAllocationExceeded', 403)
    if (tenant.paused) throw new QuotaError('quotaPaused', 403, 60)
    if (now < tenant.window_start || now >= tenant.window_end) throw new QuotaError('quotaWindowUnavailable', 503, 60)
    const rule = Object.hasOwn(tenant.resources, resource) ? tenant.resources[resource] : undefined
    const approved = Object.hasOwn(allocation.resources, resource) ? allocation.resources[resource] : undefined
    if (!approved || approved.unknownCostApproved !== true || !rule || rule.units !== approved.units || !Number.isSafeInteger(rule.units) || rule.units < 0 || rule.unknownCostApproved !== true) {
      throw new QuotaError('quotaCostApprovalRequired', 403, 60)
    }
    return rule.units as number
  }

  private async expire(client: PoolClient, workspaceId: string, now: Date) {
    // Before-send failures refund; after-send crashes retain the full allowance.
    // Neither state remains a permanent concurrency lock. No automatic resend.
    await client.query(`UPDATE quota_reservations SET state=CASE WHEN state='reserved' THEN 'refunded' ELSE 'uncertain' END,
      settled_units=CASE WHEN state='reserved' THEN 0 ELSE units END, finished_at=$2
      WHERE workspace_id=$1 AND state IN ('reserved','executing') AND expires_at <= $2`, [workspaceId, now])
  }

  private async checkHeldBudget(client: PoolClient, tenant: Record<string, any>, now: Date) {
    const { rows: [total] } = await client.query(`SELECT COALESCE(sum(COALESCE(settled_units,units)) FILTER (WHERE created_at >= $2 AND created_at < $3),0) AS used,
      COALESCE(sum(COALESCE(settled_units,units)),0) AS lifetime_used FROM quota_reservations WHERE workspace_id=$1`, [tenant.workspace_id, tenant.window_start, tenant.window_end])
    const budget = BigInt(tenant.override_until > now ? tenant.override_units : tenant.budget_units) < BigInt(tenant.allocation.max_budget_units) ? (tenant.override_until > now ? tenant.override_units : tenant.budget_units) : tenant.allocation.max_budget_units
    if (BigInt(total.used) > BigInt(budget) || BigInt(total.lifetime_used) > BigInt(tenant.allocation.max_budget_units)) throw new QuotaError('quotaBudgetExhausted', 429, (tenant.window_end.getTime() - now.getTime()) / 1000)
  }

  async reserve(input: QuotaRequest): Promise<Reservation> {
    if (!input.ownerId || !input.key || input.key.length > 256 || !input.resource || input.resource.length > 128) throw new QuotaError('quotaInvalidRequest', 400)
    const leaseMs = input.leaseMs ?? MAX_LEASE_MS
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > MAX_LEASE_MS) throw new QuotaError('quotaInvalidLease', 400)
    const fingerprint = createHash('sha256').update(canonical({ resource: input.resource, binding: input.binding })).digest('hex')
    return this.transaction(input.ownerId, async (client, tenant, now) => {
      const units = this.checkPolicy(tenant, input.resource, now)
      await this.expire(client, tenant.workspace_id, now)
      const { rows: [existing] } = await client.query('SELECT * FROM quota_reservations WHERE owner_id=$1 AND request_key=$2', [input.ownerId, input.key])
      if (existing) {
        if (existing.workspace_id !== tenant.workspace_id || existing.fingerprint !== fingerprint) throw new QuotaError('quotaKeyConflict', 409)
        return existing
      }
      const { rows: [backoff] } = await client.query('SELECT retry_at FROM quota_backoffs WHERE workspace_id=$1 AND resource=$2 AND retry_at > $3', [tenant.workspace_id, input.resource, now])
      if (backoff) throw new QuotaError('providerBackoff', 429, (backoff.retry_at.getTime() - now.getTime()) / 1000)
      const { rows: [totals] } = await client.query(`SELECT
        COALESCE(sum(COALESCE(settled_units,units)),0) AS lifetime_used,
        COALESCE(sum(COALESCE(settled_units,units)) FILTER (WHERE created_at >= $2 AND created_at < $3),0) AS used,
        count(*) FILTER (WHERE state IN ('reserved','executing')) AS active,
        count(*) FILTER (WHERE created_at > $4) AS rate,
        min(created_at) FILTER (WHERE created_at > $4) AS oldest
        FROM quota_reservations WHERE workspace_id=$1`, [tenant.workspace_id, tenant.window_start, tenant.window_end, new Date(now.getTime() - tenant.rate_window_seconds * 1000)])
      const budget = BigInt(tenant.override_until > now ? tenant.override_units : tenant.budget_units) < BigInt(tenant.allocation.max_budget_units) ? (tenant.override_until > now ? tenant.override_units : tenant.budget_units) : tenant.allocation.max_budget_units
      if (BigInt(totals.used) + BigInt(units) > BigInt(budget) || BigInt(totals.lifetime_used) + BigInt(units) > BigInt(tenant.allocation.max_budget_units)) throw new QuotaError('quotaBudgetExhausted', 429, (tenant.window_end.getTime() - now.getTime()) / 1000)
      if (Number(totals.active) >= Math.min(tenant.concurrency_limit, tenant.allocation.max_concurrency)) throw new QuotaError('quotaConcurrencyExceeded', 429)
      if (Number(totals.rate) >= Math.min(tenant.rate_limit, tenant.allocation.max_rate_limit)) throw new QuotaError('quotaRateExceeded', 429, (totals.oldest.getTime() + tenant.rate_window_seconds * 1000 - now.getTime()) / 1000)
      const { rows: [reservation] } = await client.query(`INSERT INTO quota_reservations
        (id,owner_id,workspace_id,request_key,resource,fingerprint,units,state,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8) RETURNING *`,
      [randomUUID(), input.ownerId, tenant.workspace_id, input.key, input.resource, fingerprint, units, new Date(now.getTime() + leaseMs)])
      return reservation
    })
  }

  async activate(ownerId: string, id: string): Promise<Reservation> {
    return this.transaction(ownerId, async (client, tenant, now) => {
      await this.expire(client, tenant.workspace_id, now)
      const { rows: [row] } = await client.query('SELECT * FROM quota_reservations WHERE id=$1 AND owner_id=$2 AND workspace_id=$3', [id, ownerId, tenant.workspace_id])
      if (!row) throw new QuotaError('quotaReservationNotFound', 404)
      this.checkPolicy(tenant, row.resource, now)
      await this.checkHeldBudget(client, tenant, now)
      const { rows: [backoff] } = await client.query('SELECT retry_at FROM quota_backoffs WHERE workspace_id=$1 AND resource=$2 AND retry_at > $3', [tenant.workspace_id, row.resource, now])
      if (backoff) throw new QuotaError('providerBackoff', 429, (backoff.retry_at - now.getTime()) / 1000)
      if (row.state !== 'reserved') throw new QuotaError(row.state === 'uncertain' ? 'quotaOutcomeUncertain' : 'quotaAlreadyDispatched', 409)
      const { rows: [active] } = await client.query(`UPDATE quota_reservations SET state='executing' WHERE id=$1 RETURNING *`, [id])
      return active
    })
  }

  /** Settlement is immutable: duplicate and contradictory delivery cannot charge twice. */
  async finish(ownerId: string, id: string, outcome: 'settled' | 'refunded' | 'uncertain', usage?: { inputTokens?: number; outputTokens?: number }, retryAfter?: number) {
    // Completion must work after revocation to free resources, without enabling an effect.
    const cleanup = new QuotaStore(this.pool, async () => true)
    return cleanup.transaction(ownerId, async (client, tenant, now) => {
      const { rows: [row] } = await client.query('SELECT * FROM quota_reservations WHERE id=$1 AND owner_id=$2 AND workspace_id=$3', [id, ownerId, tenant.workspace_id])
      if (!row) throw new QuotaError('quotaReservationNotFound', 404)
      if (!['reserved','executing'].includes(row.state)) return row
      if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
        await client.query(`INSERT INTO quota_backoffs(workspace_id,resource,retry_at) VALUES ($1,$2,$3)
          ON CONFLICT(workspace_id,resource) DO UPDATE SET retry_at=GREATEST(quota_backoffs.retry_at,excluded.retry_at)`, [tenant.workspace_id, row.resource, new Date(now.getTime() + Math.min(retryAfter, 31_536_000) * 1000)])
      }
      const safeUsage = usage ? Object.fromEntries(Object.entries(usage).filter(([key,value]) => ['inputTokens','outputTokens'].includes(key) && Number.isSafeInteger(value) && value! >= 0)) : null
      const { rows: [done] } = await client.query(`UPDATE quota_reservations SET state=$2, settled_units=$3, finished_at=$4, usage=$5 WHERE id=$1 RETURNING *`, [id, outcome, outcome === 'refunded' ? 0 : row.units, now, safeUsage])
      return done
    })
  }

  async renew(ownerId: string, id: string, leaseMs: number) {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > MAX_LEASE_MS) throw new QuotaError('quotaInvalidLease', 400)
    return this.transaction(ownerId, async (client, tenant, now) => {
      await this.expire(client, tenant.workspace_id, now)
      const { rows: [row] } = await client.query('SELECT * FROM quota_reservations WHERE id=$1 AND owner_id=$2 AND workspace_id=$3', [id, ownerId, tenant.workspace_id])
      if (!row || row.state !== 'executing') throw new QuotaError('quotaLeaseLost', 409)
      this.checkPolicy(tenant, row.resource, now)
      await this.checkHeldBudget(client, tenant, now)
      await client.query('UPDATE quota_reservations SET expires_at=$2 WHERE id=$1', [id, new Date(now.getTime()+leaseMs)])
    })
  }
}
