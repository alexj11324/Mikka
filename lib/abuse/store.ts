import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  abuseLimits,
  FREE_ALLOWANCE_MICRO_USD,
  HOSTED_CALL_RESERVATION,
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
  async verify(
    workspaceId: string,
    customerId: string | null,
    fingerprint: string | null,
  ) {
    return this.transaction(async (tx) => {
      await this.lock(tx, workspaceId)
      const verified = await tx.query(
        'INSERT INTO hosted_verifications ("workspaceId","customerId",fingerprint) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING "workspaceId"',
        [workspaceId, customerId, fingerprint],
      )
      if (!verified.rowCount) return false
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
    const {
      rows: [row],
    } = await tx.query(
      `SELECT
      (EXISTS(SELECT 1 FROM hosted_verifications WHERE "workspaceId"=$1) OR EXISTS(SELECT 1 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased' AND points>0)) AS verified,
      COALESCE((SELECT remaining FROM hosted_allowances WHERE "workspaceId"=$1),0)::float8 AS free,
      GREATEST(0,COALESCE((SELECT sum(points)*$2 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased'),0)-COALESCE((SELECT sum("purchasedMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedPurchased" ELSE 0 END) FROM hosted_usage WHERE "workspaceId"=$1),0))::float8 AS purchased`,
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
  async reserve(
    workspaceId: string,
    model: string,
    id: string,
    env: Record<string, string | undefined> = process.env,
    maximumCost = HOSTED_CALL_RESERVATION,
  ) {
    return this.transaction(async (tx) => {
      // One short platform admission lock; no SQL lock spans provider I/O.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      await this.lock(tx, workspaceId)
      const prior = (
        await tx.query('SELECT state FROM hosted_usage WHERE id=$1', [id])
      ).rows[0]
      if (prior) throw new PaidResourceError('usage_in_progress') // Never replay a paid provider call.
      const balance = await this.balance(workspaceId, tx)
      if (!balance.verified && balance.purchased <= 0)
        throw new PaidResourceError('verification_required')
      if (balance.free + balance.purchased <= 0)
        throw new PaidResourceError('free_allowance_used')
      if (
        (
          await tx.query(
            `SELECT 1 FROM hosted_usage WHERE "workspaceId"=$1 AND state IN ('pending','unknown')`,
            [workspaceId],
          )
        ).rowCount
      )
        throw new PaidResourceError('usage_in_progress')
      if (!Number.isSafeInteger(maximumCost) || maximumCost < 1)
        throw new Error('invalid_usage_reservation')
      const limit = abuseLimits(env)
      const spent = Number(
        (
          await tx.query(
            `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
          )
        ).rows[0].n,
      )
      let free = Math.min(balance.free, maximumCost)
      // While paused, purchased points still work without consuming free credit.
      if (spent + (free > 0 ? maximumCost : 0) > limit.dailyMicroUsd) {
        if (balance.purchased <= 0)
          throw new PaidResourceError('platform_paused')
        free = 0
      }
      const purchased = Math.min(balance.purchased, maximumCost - free)
      await tx.query(
        'UPDATE hosted_allowances SET remaining=remaining-$2 WHERE "workspaceId"=$1',
        [workspaceId, free],
      )
      await tx.query(
        `INSERT INTO hosted_usage (id,"workspaceId",model,state,"reservedFree","reservedPurchased","reservedUnpaid") VALUES ($1,$2,$3,'pending',$4,$5,$6)`,
        [id, workspaceId, model, free, purchased, free > 0 ? maximumCost : 0],
      )
      return { id, workspaceId }
    })
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
      // Unknown cost never means free. Retain the reservation and block further
      // workspace calls until the receipt is reconciled using this same method.
      if (cost === null) {
        await tx.query("UPDATE hosted_usage SET state='unknown' WHERE id=$1", [
          id,
        ])
        return
      }
      if (!Number.isSafeInteger(cost) || cost < 0)
        throw new Error('invalid_usage_cost')
      const available = await this.balance(row.workspaceId, tx)
      const free =
        Number(row.reservedFree) > 0
          ? Math.min(cost, Number(row.reservedFree) + available.free)
          : 0
      const purchased = cost - free
      const unpaid =
        Number(row.reservedFree) > 0
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
        `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=$3,"purchasedMicroUsd"=$4,"inputTokens"=$5,"outputTokens"=$6,"generationId"=$7,"unpaidMicroUsd"=$8,"settledAt"=now() WHERE id=$1`,
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
    const pending = (
      await this.pool.query(
        `SELECT state FROM hosted_usage WHERE "workspaceId"=$1 AND state IN ('pending','unknown') LIMIT 1`,
        [workspaceId],
      )
    ).rows[0]
    const spent = Number(
      (
        await this.pool.query(
          `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
        )
      ).rows[0].n,
    )
    const state = !balance.verified
      ? 'verification_required'
      : pending
        ? pending.state === 'unknown'
          ? 'usage_cost_unavailable'
          : 'usage_in_progress'
        : balance.free + balance.purchased <= 0
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
