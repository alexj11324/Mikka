import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  abuseLimits,
  FREE_ALLOWANCE_MICRO_USD,
  HOSTED_CALL_HOLD_MICRO_USD,
  HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE,
  MICRO_USD_PER_POINT,
  PaidResourceError,
} from './policy'

type Query = Pick<PoolClient, 'query'>
export class HostedUsageStore {
  constructor(readonly pool: Pool) {}
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await this.pool.connect()
    try {
      await tx.query('BEGIN')
      const result = await work(tx)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally {
      tx.release()
    }
  }
  private async lock(tx: Query, workspaceId: string) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `hosted:${workspaceId}`,
    ])
  }
  /**
   * Fail reservations that can no longer settle, so a stuck row never keeps its
   * hold and concurrency slot forever. A real call settles within
   * HOSTED_CALL_TIMEOUT_MS (60s); the 10-minute margin is far wider so a live
   * stream is never cut. A pending row past it crashed before settling; an
   * unknown row with no generationId can never be reconciled (the cost lookup
   * needs the id). Any reserved free allowance is refunded; no money was charged.
   * The caller already holds the workspace lock.
   */
  private async releaseAbandoned(tx: Query, workspaceId: string) {
    const reaped = await tx.query<{ reservedFree: string }>(
      `UPDATE hosted_usage SET state='failed',"settledAt"=now()
       WHERE "workspaceId"=$1 AND "settledAt" IS NULL AND "createdAt" < now() - interval '10 minutes'
         AND (state='pending' OR (state='unknown' AND "generationId" IS NULL))
       RETURNING "reservedFree"`,
      [workspaceId],
    )
    const refund = reaped.rows.reduce((sum, row) => sum + Number(row.reservedFree), 0)
    if (refund > 0)
      await tx.query(
        'UPDATE hosted_allowances SET remaining=remaining+$2 WHERE "workspaceId"=$1',
        [workspaceId, refund],
      )
  }
  async verify(
    workspaceId: string,
    customerId: string | null,
    fingerprint: string | null,
    last4: string | null = null,
  ) {
    return this.transaction(async (tx) => {
      await this.lock(tx, workspaceId)
      const verified = await tx.query(
        'INSERT INTO hosted_verifications ("workspaceId","customerId",fingerprint,last4) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING "workspaceId"',
        [workspaceId, customerId, fingerprint, last4],
      )
      if (!verified.rowCount) {
        if (fingerprint) {
          const filled = await tx.query('UPDATE hosted_verifications SET "customerId"=$2,fingerprint=$3,last4=$4 WHERE "workspaceId"=$1 AND (fingerprint IS NULL OR (fingerprint=$3 AND last4 IS NULL AND $4::text IS NOT NULL)) RETURNING "workspaceId"', [workspaceId, customerId, fingerprint, last4])
          if (filled.rowCount) await tx.query('INSERT INTO hosted_card_claims (fingerprint,"workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [fingerprint, workspaceId])
        }
        return false
      }
      const first =
        !fingerprint ||
        Boolean(
          (
            await tx.query(
              'INSERT INTO hosted_card_claims (fingerprint,"workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING fingerprint',
              [fingerprint, workspaceId],
            )
          ).rowCount,
        )
      if (first)
        await tx.query(
          'INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [workspaceId, FREE_ALLOWANCE_MICRO_USD],
        )
      await tx.query(
        `INSERT INTO workspace_audit_events (id,"workspaceId","actorType","actorName",action,category,metadata) VALUES ($1,$2,'system','Stripe','billing.card_verified','billing',$3)`,
        [
          randomUUID(),
          workspaceId,
          JSON.stringify({ allowanceGranted: first }),
        ],
      )
      return first
    })
  }
  async balance(workspaceId: string, tx: Query = this.pool) {
    // Already-incurred debt offsets unused free credit as well. Clamping each
    // bucket independently must not turn an overdraft into new spending power.
    const {
      rows: [row],
    } = await tx.query(
      `WITH balances AS (SELECT
      (EXISTS(SELECT 1 FROM hosted_verifications WHERE "workspaceId"=$1) OR EXISTS(SELECT 1 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased' AND points>0)) AS verified,
      COALESCE((SELECT remaining FROM hosted_allowances WHERE "workspaceId"=$1),0) AS free,
      COALESCE((SELECT sum(points)*$2 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased'),0)-COALESCE((SELECT sum("purchasedMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedPurchased" ELSE 0 END) FROM hosted_usage WHERE "workspaceId"=$1),0) AS purchased)
      SELECT verified,GREATEST(0,free+LEAST(0,purchased))::float8 AS free,GREATEST(0,purchased)::float8 AS purchased FROM balances`,
      [workspaceId, MICRO_USD_PER_POINT],
    )
    return row as { verified: boolean; free: number; purchased: number }
  }
  async canUseMikkaPaid(workspaceId: string) {
    const balance = await this.balance(workspaceId)
    if (!balance.verified && balance.purchased <= 0)
      throw new PaidResourceError('verification_required')
    if (balance.free + balance.purchased <= 0)
      throw new PaidResourceError(
        balance.verified ? 'free_allowance_used' : 'points_exhausted',
      )
    return balance
  }
  /** Holds and slots of this workspace's calls that have not settled. */
  private async inFlight(tx: Query, workspaceId: string) {
    const {
      rows: [row],
    } = await tx.query(
      `SELECT COALESCE(sum("holdMicroUsd"),0)::float8 AS held, count(*) FILTER (WHERE state='pending')::int AS calls
       FROM hosted_usage WHERE "workspaceId"=$1 AND state IN ('pending','unknown')`,
      [workspaceId],
    )
    return row as { held: number; calls: number }
  }
  async reserve(
    workspaceId: string,
    model: string,
    id: string,
    env: Record<string, string | undefined> = process.env,
    estimate = HOSTED_CALL_HOLD_MICRO_USD,
  ) {
    return this.transaction(async (tx) => {
      // One short platform admission lock; no SQL lock spans provider I/O.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      await this.lock(tx, workspaceId)
      // Release an abandoned reservation so one stuck call never keeps its hold.
      // A hosted call runs at most HOSTED_CALL_TIMEOUT_MS; a pending row past a
      // wide margin crashed before settling, and an unknown row with no
      // generationId can never be reconciled (the cost lookup needs it).
      await this.releaseAbandoned(tx, workspaceId)
      const prior = (
        await tx.query('SELECT state FROM hosted_usage WHERE id=$1', [id])
      ).rows[0]
      if (prior) throw new PaidResourceError('usage_in_progress') // Never replay a paid provider call.
      const balance = await this.balance(workspaceId, tx)
      if (!balance.verified && balance.purchased <= 0)
        throw new PaidResourceError('verification_required')
      const available = balance.free + balance.purchased
      if (available <= 0) throw new PaidResourceError('free_allowance_used')
      const flight = await this.inFlight(tx, workspaceId)
      if (flight.calls >= HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE)
        throw new PaidResourceError('usage_concurrency_limit')
      // Concurrent calls must fit the balance together. A lone call is admitted
      // on any positive balance, as before, so the last cents stay usable.
      if (flight.held > 0 && available - flight.held < estimate)
        throw new PaidResourceError('free_allowance_used')
      const limit = abuseLimits(env)
      const spent = Number(
        (
          await tx.query(
            `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
          )
        ).rows[0].n,
      )
      if (spent >= limit.dailyMicroUsd && balance.purchased <= 0)
        throw new PaidResourceError('platform_paused')
      // The hold only gates admission; settlement charges the actual cost.
      await tx.query(
        `INSERT INTO hosted_usage (id,"workspaceId",model,state,"holdMicroUsd") VALUES ($1,$2,$3,'pending',$4)`,
        [id, workspaceId, model, estimate],
      )
      return { id, workspaceId }
    })
  }
  /** Persist the upstream lookup identity before exposing its first content. */
  async recordGeneration(id: string, generationId: string) {
    if (!generationId || generationId.length > 200) throw new Error('invalid_usage_generation')
    const result = await this.pool.query(
      `UPDATE hosted_usage SET "generationId"=COALESCE("generationId",$2)
       WHERE id=$1 AND state IN ('pending','unknown')
         AND ("generationId" IS NULL OR "generationId"=$2) RETURNING id`,
      [id, generationId],
    )
    if (!result.rowCount) throw new PaidResourceError('usage_cost_unavailable')
  }
  async settle(
    id: string,
    cost: number | null,
    inputTokens = 0,
    outputTokens = 0,
    generationId?: string,
  ) {
    return this.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      const row = (
        await tx.query('SELECT * FROM hosted_usage WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0]
      if (!row || row.state === 'settled' || row.state === 'failed') return
      await this.lock(tx, row.workspaceId)
      if (generationId && row.generationId && generationId !== row.generationId)
        throw new Error('usage_generation_mismatch')
      // Unknown cost never means free. Retain the receipt record and keep its hold
      // until the receipt is reconciled using this same method.
      if (cost === null) {
        await tx.query(
          'UPDATE hosted_usage SET state=\'unknown\',"generationId"=COALESCE($2,"generationId") WHERE id=$1',
          [id, generationId ?? null],
        )
        return
      }
      if (!Number.isSafeInteger(cost) || cost < 0)
        throw new Error('invalid_usage_cost')
      const available = await this.balance(row.workspaceId, tx)
      // Old rows may already have debited free credit or frozen purchased points.
      // Settle those exact rows without charging their prepaid money twice.
      const legacy = Number(row.reservedFree) > 0 || Number(row.reservedPurchased) > 0 || Number(row.reservedUnpaid) > 0
      const spent = Number((await tx.query(`SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`)).rows[0].n)
      const useFree = legacy ? Number(row.reservedFree) > 0 : spent < abuseLimits().dailyMicroUsd
      const free =
        useFree
          ? Math.min(cost, Number(row.reservedFree) + available.free)
          : 0
      const purchased = cost - free
      const unpaid =
        useFree
          ? free +
            Math.max(
              0,
              purchased - available.purchased - Number(row.reservedPurchased),
            )
          : 0 // Any one-call overrun stays as debt; never erase it.
      await tx.query(
        'UPDATE hosted_allowances SET remaining=remaining+$2-$3 WHERE "workspaceId"=$1',
        [row.workspaceId, Number(row.reservedFree), free],
      )
      await tx.query(
        `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=$3,"purchasedMicroUsd"=$4,"inputTokens"=$5,"outputTokens"=$6,"generationId"=COALESCE($7,"generationId"),"unpaidMicroUsd"=$8,"settledAt"=now() WHERE id=$1`,
        [
          id,
          cost,
          free,
          purchased,
          inputTokens,
          outputTokens,
          generationId ?? null,
          unpaid,
        ],
      )
    })
  }
  async status(
    workspaceId: string,
    env: Record<string, string | undefined> = process.env,
  ) {
    const balance = await this.balance(workspaceId)
    const flight = await this.inFlight(this.pool, workspaceId)
    const spent = Number(
      (
        await this.pool.query(
          `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
        )
      ).rows[0].n,
    )
    // Whether the next call would be admitted, by the same rules as reserve().
    const available = balance.free + balance.purchased
    const state = !balance.verified
      ? 'verification_required'
      : available <= 0
        ? 'free_allowance_used'
        : flight.calls >= HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE
          ? 'usage_concurrency_limit'
          : flight.held > 0 && available - flight.held < HOSTED_CALL_HOLD_MICRO_USD
            ? 'free_allowance_used'
            : spent >= abuseLimits(env).dailyMicroUsd && balance.purchased <= 0
              ? 'platform_paused'
              : 'ready'
    return { state, balance }
  }
  async recent(workspaceId: string) {
    return (
      await this.pool.query(
        `SELECT id,model,state,"costMicroUsd","freeMicroUsd","purchasedMicroUsd","inputTokens","outputTokens","createdAt" FROM hosted_usage WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC LIMIT 50`,
        [workspaceId],
      )
    ).rows
  }
}
