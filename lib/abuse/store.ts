import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { hostedBillingScope } from './context'
import { resourceBudgetAdmission } from '../billing/resource-budgets'
import {
  abuseLimits,
  FREE_ALLOWANCE_MICRO_USD,
  HOSTED_CALL_HOLD_MICRO_USD,
  HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE,
  MICRO_USD_PER_POINT,
  PaidResourceError,
  TRIAL_MESSAGES,
} from './policy'

type Query = Pick<PoolClient, 'query'>
export type HostedQuotaLease = { limit: number; close(): Promise<void>;
  billingAccount?: { workspaceId: string; organizationId: string | null } }
export class HostedUsageStore {
  readonly metered: boolean
  readonly allowTrial: boolean
  private readonly quota?: (workspaceId: string) => Promise<HostedQuotaLease>
  private readonly workspaceDatabase: Pick<Pool, 'query'>
  constructor(readonly pool: Pool, options: {
    metered?: boolean
    allowTrial?: boolean
    quota?: (workspaceId: string) => Promise<HostedQuotaLease>
    /** Workspace identity lives in WS DB; APP-only deployments must supply it. */
    workspaceDatabase?: Pick<Pool, 'query'>
  } = {}) {
    this.metered = options.metered ?? true
    this.allowTrial = options.allowTrial ?? true
    this.quota = options.quota
    this.workspaceDatabase = options.workspaceDatabase ?? pool
  }
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
    if (!this.metered) return false
    return this.transaction(async (tx) => {
      await this.lock(tx, workspaceId)
      const verified = await tx.query(
        'INSERT INTO hosted_verifications ("workspaceId","customerId",fingerprint,last4) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING "workspaceId"',
        [workspaceId, customerId, fingerprint, last4],
      )
      if (!verified.rowCount) {
        if (fingerprint) {
          const filled = await tx.query('UPDATE hosted_verifications SET "customerId"=$2,fingerprint=$3,last4=$4 WHERE "workspaceId"=$1 AND (fingerprint IS NULL OR (fingerprint=$3 AND last4 IS NULL AND $4::text IS NOT NULL)) RETURNING "workspaceId"', [workspaceId, customerId, fingerprint, last4])
          if (filled.rowCount) {
            await tx.query('INSERT INTO hosted_card_claims (fingerprint,"workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [fingerprint, workspaceId])
            // The card's last four digits now show (#1212: the page waiting on the webhook reads on this key).
            await (await import('../live/billing')).hostedBillingChanged(tx, workspaceId)
          }
        }
        return false
      }
      // Verified (and perhaps the allowance granted): the page waiting on the webhook reads again (#1212).
      await (await import('../live/billing')).hostedBillingChanged(tx, workspaceId)
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
  async balance(workspaceId: string, tx: Query = this.pool, at = new Date()) {
    if (!this.metered) return { verified: true, free: 0, plan: 0, purchased: 0 }
    // Already-incurred debt offsets unused free credit as well. Clamping each
    // bucket independently must not turn an overdraft into new spending power.
    const {
      rows: [row],
    } = await tx.query(
      `WITH balances AS (SELECT
      (EXISTS(SELECT 1 FROM hosted_verifications WHERE "workspaceId"=$1) OR EXISTS(SELECT 1 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND points>0 AND (bucket='purchased' OR (bucket='plan' AND ("periodStart" IS NULL OR "periodStart"<=$3) AND ("expiresAt" IS NULL OR "expiresAt">$3))))) AS verified,
      COALESCE((SELECT remaining FROM hosted_allowances WHERE "workspaceId"=$1),0) AS free,
      COALESCE((SELECT sum(GREATEST(0,(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint-COALESCE((SELECT sum((u."planAllocations"->>g.id::text)::bigint) FROM hosted_usage u WHERE u."workspaceId"=$1),0)))
        FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='plan' AND g."parentGrantId" IS NULL AND g.points>0 AND (g."periodStart" IS NULL OR g."periodStart"<=$3) AND (g."expiresAt" IS NULL OR g."expiresAt">$3)),0) AS plan,
      COALESCE((SELECT sum(points)*$2 FROM workspace_credit_grants WHERE "workspaceId"=$1 AND bucket='purchased'),0)-COALESCE((SELECT sum("purchasedMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedPurchased" ELSE 0 END) FROM hosted_usage WHERE "workspaceId"=$1),0) AS purchased)
      SELECT verified,GREATEST(0,free+LEAST(0,purchased+plan))::float8 AS free,
        GREATEST(0,plan+LEAST(0,purchased))::float8 AS plan,GREATEST(0,purchased)::float8 AS purchased FROM balances`,
      [workspaceId, MICRO_USD_PER_POINT, at],
    )
    return row as { verified: boolean; free: number; plan: number; purchased: number }
  }

  private attribution(workspaceId: string) {
    const scope = hostedBillingScope.getStore()
    return scope?.billingAccountWorkspaceId === workspaceId ? scope : { workspaceId }
  }
  /** Actual receipts plus in-flight holds, serialized by the existing hosted admission lock. */
  private async budget(workspaceId: string, sourceWorkspaceId: string, estimate: number, tx: Query = this.pool, requireCompleteAttribution = true) {
    const { rows } = await tx.query<{ workspaceId: string; limit: number; spent: number }>(`SELECT s."workspaceId",s."monthlyCreditLimit"*$3::float8 AS "limit",
      COALESCE((SELECT sum(CASE WHEN u.state IN ('pending','unknown') THEN COALESCE(u."costMicroUsd",u."holdMicroUsd") ELSE COALESCE(u."costMicroUsd",0) END)
        FROM hosted_usage u WHERE (CASE WHEN s."workspaceId"=$1 THEN u."workspaceId"=s."workspaceId" ELSE COALESCE(u."usageWorkspaceId",u."workspaceId")=s."workspaceId" END)
          AND u.state<>'failed' AND u."createdAt">=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::float8 AS spent
      FROM workspace_settings s WHERE s."workspaceId"=ANY($2::uuid[]) AND s."monthlyCreditLimit" IS NOT NULL`,
    [workspaceId, [...new Set([workspaceId, sourceWorkspaceId])], MICRO_USD_PER_POINT])
    return rows.every(row => row.limit - row.spent > 0 && row.limit - row.spent >= estimate)
      && resourceBudgetAdmission(tx, workspaceId, this.attribution(workspaceId), estimate, requireCompleteAttribution)
  }
  /**
   * The free messages left before a card is needed (TRIAL_MESSAGES), for a
   * workspace with no verified card and no purchased points; null for any
   * other. The allowance is the person's, not the workspace's: it counts the
   * messages sent in the chats of every workspace created by this workspace's
   * creator, so a second workspace adds none. Not a 重试, not the welcome
   * request; the one being answered is included, so its turn is admitted
   * while this is 0 or more.
   */
  private async trialWorkspaces(workspaceId: string) {
    const { rows } = await this.workspaceDatabase.query<{ id: string }>(
      'select id from mikka_workspaces where "userId"=(select "userId" from mikka_workspaces where id=$1)', [workspaceId])
    return rows.map(row => row.id)
  }
  async trialLeft(workspaceId: string, balance: { verified: boolean; purchased: number }, tx: Query = this.pool, workspaceIds?: string[]) {
    if (!this.metered) return null
    if (balance.verified || balance.purchased > 0) return null
    const scope = workspaceIds ?? await this.trialWorkspaces(workspaceId)
    const { rows: [row] } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM coordinator_events e JOIN bots b ON b.id=e."botId"
       WHERE b."workspaceId"=ANY($1::uuid[]) AND e.kind='user_message' AND e.payload->>'retry' IS NULL AND coalesce(e.payload->>'text','') NOT LIKE '[Welcome]%'`,
      [scope],
    )
    return TRIAL_MESSAGES - Number(row?.n ?? 0)
  }
  async canUseMikkaPaid(workspaceId: string) {
    const balance = await this.balance(workspaceId)
    if (!this.metered) return balance
    if (!await this.budget(workspaceId, this.attribution(workspaceId).workspaceId, 0)) throw new PaidResourceError('usage_budget_exhausted')
    if (!balance.verified && balance.purchased <= 0) {
      if (!this.allowTrial) throw new PaidResourceError('verification_required')
      const left = await this.trialLeft(workspaceId, balance)
      if (left !== null && left >= 0) return { ...balance, trialLeft: left }
      throw new PaidResourceError('verification_required')
    }
    if (balance.free + balance.plan + balance.purchased <= 0)
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
    if (!this.metered) return { id, workspaceId }
    if (!Number.isSafeInteger(estimate) || estimate <= 0) throw new Error('invalid_usage_hold')
    const attribution = this.attribution(workspaceId)
    // Resolve WS identity before pinning either pool's transaction. WS and APP
    // can both have max=1; no cross-database JOIN or nested pool checkout occurs.
    const trialWorkspaces = this.allowTrial ? await this.trialWorkspaces(workspaceId) : undefined
    // Pin plan authority before reserving an APP connection, matching the
    // workspace -> APP order used by task and governance writers.
    const quota = await this.quota?.(attribution.workspaceId)
    try { return await this.transaction(async (tx) => {
      // One short platform admission lock; no SQL lock spans provider I/O.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hosted-free-budget',0))",
      )
      await this.lock(tx, workspaceId)
      // Product concurrency never grants spending authority or a free allowance.
      if (quota?.billingAccount) {
        const current = quota.billingAccount
        if (current.organizationId !== (attribution.billingOrganizationId ?? null)
          || (current.organizationId && current.workspaceId !== workspaceId)) throw new PaidResourceError('billing_authorization_revoked')
      }
      if (attribution.creditShareOwnerId) {
        const share = await tx.query('select 1 from workspace_credit_shares where "workspaceId"=$1 and "userId"=$2 for share', [attribution.workspaceId, attribution.creditShareOwnerId])
        if (!share.rows.length) throw new PaidResourceError('billing_authorization_revoked')
      }
      // Release an abandoned reservation so one stuck call never keeps its hold.
      // A hosted call runs at most HOSTED_CALL_TIMEOUT_MS; a pending row past a
      // wide margin crashed before settling, and an unknown row with no
      // generationId can never be reconciled (the cost lookup needs it).
      await this.releaseAbandoned(tx, workspaceId)
      const prior = (
        await tx.query('SELECT state FROM hosted_usage WHERE id=$1', [id])
      ).rows[0]
      if (prior) throw new PaidResourceError('usage_in_progress') // Never replay a paid provider call.
      if (!await this.budget(workspaceId, attribution.workspaceId, estimate, tx)) throw new PaidResourceError('usage_budget_exhausted')
      const balance = await this.balance(workspaceId, tx)
      // No card and nothing bought: only the first TRIAL_MESSAGES messages' turns, paid by the platform.
      if (!this.allowTrial && !balance.verified && balance.purchased <= 0) throw new PaidResourceError('verification_required')
      const trial = this.allowTrial ? await this.trialLeft(workspaceId, balance, tx, trialWorkspaces) : null
      if (trial !== null && trial < 0)
        throw new PaidResourceError('verification_required')
      const available = balance.free + balance.plan + balance.purchased
      if (trial === null && available <= 0) throw new PaidResourceError('free_allowance_used')
      const flight = await this.inFlight(tx, workspaceId)
      if (flight.calls >= (quota?.limit ?? HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE))
        throw new PaidResourceError('usage_concurrency_limit')
      // Concurrent calls must fit the balance together. A lone call is admitted
      // on any positive balance, as before, so the last cents stay usable.
      if (trial === null && flight.held > 0 && available - flight.held < estimate)
        throw new PaidResourceError('free_allowance_used')
      const limit = abuseLimits(env)
      const spent = Number(
        (
          await tx.query(
            `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
          )
        ).rows[0].n,
      )
      if (spent >= limit.dailyMicroUsd && balance.plan + balance.purchased <= 0)
        throw new PaidResourceError('platform_paused')
      // The hold only gates admission; settlement charges the actual cost.
      await tx.query(
        `INSERT INTO hosted_usage (id,"workspaceId",model,state,"holdMicroUsd","usageWorkspaceId","billingOrganizationId","executionOwnerId","actorId","usageProjectId","usageThreadId","usageRunId","attributionComplete")
          VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, workspaceId, model, estimate, attribution.workspaceId, attribution.billingOrganizationId ?? null, attribution.ownerId ?? null,
          attribution.actorId ?? null, attribution.projectId ?? null, attribution.threadId ?? null, attribution.runId ?? null, attribution.attributionComplete ?? false],
      )
      return { id, workspaceId }
    }) } finally { await quota?.close() }
  }
  /** Persist the upstream lookup identity before exposing its first content. */
  async recordGeneration(id: string, generationId: string) {
    if (!this.metered) return
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
    if (!this.metered) return
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
      // A call admitted just before the period ended keeps access to that paid
      // period's remaining grant; it never consumes a future period's allowance.
      const available = await this.balance(row.workspaceId, tx, row.createdAt)
      const legacyRow = Number(row.reservedFree) > 0 || Number(row.reservedPurchased) > 0 || Number(row.reservedUnpaid) > 0
      // A free-message turn (no card, nothing bought): the platform pays, as unpaid spend under its daily cap,
      // never as a debt the workspace's allowance would repay once a card is verified.
      if (!legacyRow && !available.verified && available.purchased <= 0) {
        await tx.query(
          `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=0,"purchasedMicroUsd"=0,"inputTokens"=$3,"outputTokens"=$4,"generationId"=COALESCE($5,"generationId"),"unpaidMicroUsd"=$2,"settledAt"=now() WHERE id=$1`,
          [id, cost, inputTokens, outputTokens, generationId ?? null],
        )
        return
      }
      // Old rows may already have debited free credit or frozen purchased points.
      // Settle those exact rows without charging their prepaid money twice.
      const legacy = Number(row.reservedFree) > 0 || Number(row.reservedPurchased) > 0 || Number(row.reservedUnpaid) > 0
      const spent = Number((await tx.query(`SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`)).rows[0].n)
      const useFree = legacy ? Number(row.reservedFree) > 0 : spent < abuseLimits().dailyMicroUsd
      const free =
        useFree
          ? Math.min(cost, Number(row.reservedFree) + available.free)
          : 0
      let remainingPlan = Math.min(cost - free, available.plan)
      const plan = remainingPlan
      const allocations: Record<string, number> = {}
      if (remainingPlan > 0) {
        const grants = await tx.query<{ id: string; remaining: number }>(`SELECT g.id,GREATEST(0,(g.points::bigint+COALESCE((SELECT sum(r.points) FROM workspace_credit_grants r WHERE r."parentGrantId"=g.id),0))*$2::bigint-COALESCE((SELECT sum((u."planAllocations"->>g.id::text)::bigint) FROM hosted_usage u WHERE u."workspaceId"=$1),0))::float8 AS remaining
          FROM workspace_credit_grants g WHERE g."workspaceId"=$1 AND g.bucket='plan' AND g."parentGrantId" IS NULL AND g.points>0 AND (g."periodStart" IS NULL OR g."periodStart"<=$3) AND (g."expiresAt" IS NULL OR g."expiresAt">$3)
          ORDER BY g."expiresAt" ASC NULLS LAST,g.id`, [row.workspaceId, MICRO_USD_PER_POINT, row.createdAt])
        for (const grant of grants.rows) {
          const amount = Math.min(remainingPlan, grant.remaining)
          if (amount > 0) allocations[grant.id] = amount
          remainingPlan -= amount
          if (remainingPlan === 0) break
        }
        if (remainingPlan !== 0) throw new Error('billing_plan_allocation_changed')
      }
      const purchased = cost - free - plan
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
        `UPDATE hosted_usage SET state='settled',"costMicroUsd"=$2,"freeMicroUsd"=$3,"purchasedMicroUsd"=$4,"inputTokens"=$5,"outputTokens"=$6,"generationId"=COALESCE($7,"generationId"),"unpaidMicroUsd"=$8,"planMicroUsd"=$9,"planAllocations"=$10,"settledAt"=now() WHERE id=$1`,
        [
          id,
          cost,
          free,
          purchased,
          inputTokens,
          outputTokens,
          generationId ?? null,
          unpaid,
          plan,
          JSON.stringify(allocations),
        ],
      )
    })
  }
  async status(
    workspaceId: string,
    env: Record<string, string | undefined> = process.env,
  ) {
    const balance = await this.balance(workspaceId)
    if (!this.metered) return { state: 'ready', balance, trialLeft: null }
    const flight = await this.inFlight(this.pool, workspaceId)
    const spent = Number(
      (
        await this.pool.query(
          `SELECT COALESCE(sum("unpaidMicroUsd"+CASE WHEN state IN ('pending','unknown') THEN "reservedUnpaid" ELSE 0 END),0) AS n FROM hosted_usage WHERE "createdAt">now()-interval '24 hours'`,
        )
      ).rows[0].n,
    )
    // Whether the next call would be admitted, by the same rules as reserve().
    const available = balance.free + balance.plan + balance.purchased
    // A billing page has no particular Project/Thread/Run. It summarizes the
    // known scopes; reserve() still requires complete execution attribution.
    const withinBudget = await this.budget(workspaceId, this.attribution(workspaceId).workspaceId, HOSTED_CALL_HOLD_MICRO_USD, this.pool, false)
    const trial = this.allowTrial ? await this.trialLeft(workspaceId, balance) : null
    // These pool reads retain no APP connection. Once the plan is pinned,
    // status computes the response without acquiring another APP connection.
    const quota = await this.quota?.(this.attribution(workspaceId).workspaceId)
    try {
    const state = !withinBudget ? 'usage_budget_exhausted' : trial !== null
      ? trial > 0 ? (spent >= abuseLimits(env).dailyMicroUsd ? 'platform_paused' : 'ready') : 'verification_required'
      : !balance.verified
      ? 'verification_required'
      : available <= 0
        ? 'free_allowance_used'
        : flight.calls >= (quota?.limit ?? HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE)
          ? 'usage_concurrency_limit'
          : flight.held > 0 && available - flight.held < HOSTED_CALL_HOLD_MICRO_USD
            ? 'free_allowance_used'
            : spent >= abuseLimits(env).dailyMicroUsd && balance.plan + balance.purchased <= 0
              ? 'platform_paused'
              : 'ready'
    return { state, balance, trialLeft: trial === null ? null : Math.max(0, trial) }
    } finally { await quota?.close() }
  }
  async recent(workspaceId: string, sourceWorkspaceId?: string) {
    if (!this.metered) return []
    return (
      await this.pool.query(
        `SELECT id,model,state,"costMicroUsd","freeMicroUsd","planMicroUsd","purchasedMicroUsd","inputTokens","outputTokens","createdAt","usageWorkspaceId","billingOrganizationId" FROM hosted_usage WHERE "workspaceId"=$1
          AND ($2::uuid IS NULL OR COALESCE("usageWorkspaceId","workspaceId")=$2::uuid) ORDER BY "createdAt" DESC LIMIT 50`,
        [workspaceId, sourceWorkspaceId ?? null],
      )
    ).rows
  }
}
