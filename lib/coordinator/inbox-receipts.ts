import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ModelMessage } from 'ai'
import { factoryEventId } from '../factory/event-id'
import { eventPrompt } from './context'
import { intentDigest, type ActionContext } from '../operations/action-intents'
import type { CoordinatorEventKind, CoordinatorEventTier } from '../db/schema'

export type WakeDelivery = { eventId: string; token: string }
export type WakeExecution = { holder: string; delivery: WakeDelivery; operationKey: string; binding: string }
export type WakeEvent = {
  id: string
  userId: string
  kind: CoordinatorEventKind
  tier: CoordinatorEventTier | null
  payload: Record<string, unknown>
  issueId: string | null
  runId: string | null
  deliveredAt: Date | null
  wake_status: string
  processed_at: Date | null
  processing_holder: string | null
  wake_delivery_token: string | null
  wake_attempts: number
  wake_replays: number
  wake_workspace_id: string | null
  wake_generation_state: string
  wake_generation_holder: string | null
  wake_checkpoint: { messages: ModelMessage[]; warning: string | null } | null
  wake_checkpoint_digest: string | null
  wake_tool_receipts: Record<string, { binding: string; value: unknown }>
  wake_error: string | null
  accountActionBatch: { holder: string; closed: boolean; batches: unknown[] } | null
}
export class WakeError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code)
  }
}
export type WakeAuthorization = (
  tx: PoolClient,
  event: WakeEvent,
  phase: 'dispatch' | 'consume' | 'commit' | 'replay' | 'read',
) => Promise<'normal' | 'notify_only'>
/** Compatibility boundary for #265. An admission refusal defers delivery without
 * consuming a retry or granting authority. No old budget implementation imported. */
export type WakeAdmission = (
  scope: { ownerId: string; workspaceId: string | null; operationId: string; generation: number },
  phase: 'dispatch' | 'consume',
) => Promise<{ admitted: true } | { admitted: false; retryAt: Date }>
export type WakeScopeGuard = <T>(
  event: WakeEvent,
  phase: 'dispatch' | 'consume' | 'commit' | 'read' | 'replay',
  work: () => Promise<T>,
) => Promise<T>
export type InboxOptions = {
  scopeGuard?: WakeScopeGuard
  authorize?: WakeAuthorization
  admit?: WakeAdmission
  clock?: () => Date
  leaseMs?: number
  deliveryLeaseMs?: number
  retryBaseMs?: number
  maxAttempts?: number
}
const fallbackAuthorization: WakeAuthorization = async (tx, event) => {
  if (!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [event.userId])).rowCount)
    throw new WakeError('wakeOwnerUnavailable', 403)
  // Explicit workspace events must have an injected current-membership authority.
  if (event.wake_workspace_id) throw new WakeError('wakeWorkspaceAuthorityRequired', 403)
  return 'normal'
}
const foreground = (event: WakeEvent) =>
  event.kind !== 'issue_done' && (event.tier === 'attention' || event.tier === 'result')
export type InboxReceipt = {
  held: boolean
  added: number
  delivery?: WakeDelivery
  operationId?: string
  recovery?: boolean
  notifyOnly?: boolean
  notification?: string
  hasCheckpoint?: boolean
  actionContext?: ActionContext & { recovery: boolean }
}
export type WakeClaim =
  { owner: string; delivery: WakeDelivery } | { owner: string; exhausted: true } | { owner: string; deferred: true }
export class CoordinatorInbox {
  private clock: () => Date
  private authorize: WakeAuthorization
  constructor(
    private pool: Pool,
    private options: InboxOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date())
    this.authorize = options.authorize ?? fallbackAuthorization
  }
  private async tx<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await this.pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query("SET LOCAL lock_timeout='5s'")
      const result = await work(tx)
      await tx.query('COMMIT')
      return result
    } catch (e) {
      await tx.query('ROLLBACK')
      throw e
    } finally {
      tx.release()
    }
  }
  private async scoped<T>(
    owner: string,
    id: string,
    phase: 'dispatch' | 'consume' | 'commit' | 'read' | 'replay',
    work: (tx: PoolClient) => Promise<T>,
  ) {
    const event = (
      await this.pool.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2', [id, owner])
    ).rows[0]
    if (!event) throw new WakeError('wakeNotFound', 404)
    return this.options.scopeGuard ? this.options.scopeGuard(event, phase, () => this.tx(work)) : this.tx(work)
  }
  private async session(tx: PoolClient, owner: string) {
    await tx.query('INSERT INTO coordinator_sessions("userId") VALUES($1) ON CONFLICT DO NOTHING', [owner])
    return (await tx.query('SELECT * FROM coordinator_sessions WHERE "userId"=$1 FOR UPDATE', [owner])).rows[0]
  }
  private async admission(event: WakeEvent, phase: 'dispatch' | 'consume') {
    return (
      this.options.admit?.(
        {
          ownerId: event.userId,
          workspaceId: event.wake_workspace_id,
          operationId: event.id,
          generation: event.wake_replays,
        },
        phase,
      ) ?? { admitted: true as const }
    )
  }
  private async noteFailure(tx: PoolClient, event: WakeEvent, code: string, terminal: boolean | 'failed' = false) {
    const failed = terminal || event.wake_attempts >= (this.options.maxAttempts ?? 5)
    const next = new Date(
      this.clock().getTime() +
        Math.min(900000, (this.options.retryBaseMs ?? 30000) * 2 ** Math.max(0, event.wake_attempts - 1)),
    )
    await tx.query(
      `UPDATE coordinator_events SET wake_status=$2,wake_error=$3,wake_next_at=$4,wake_lease_until=NULL,processing_holder=NULL WHERE id=$1 AND processed_at IS NULL`,
      [
        event.id,
        terminal === 'failed' ? 'failed' : terminal ? 'cancelled' : failed ? 'failed' : 'pending',
        failed && !terminal && code !== 'wakeGenerationUncertain' ? 'wakeRetriesExhausted' : code,
        next,
      ],
    )
    await tx.query(
      `UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL,active_event_id=NULL,"lastError"=$2,"lastErrorAt"=$3,"updatedAt"=$3 WHERE "userId"=$1 AND (active_event_id=$4 OR active_event_id IS NULL)`,
      [
        event.userId,
        failed
          ? 'Coordinator delivery needs attention; inspect the persisted event and replay after reconciliation.'
          : 'Coordinator delivery failed; a persisted retry is queued.',
        this.clock(),
        event.id,
      ],
    )
  }
  /** Claim owner first, then event: same lock order as consumer/ACK/domain slots. */
  async claim(onlyOwner?: string): Promise<WakeClaim | null> {
    const reservation = await this.tx<WakeClaim | null>(async (tx) => {
      const now = this.clock()
      await tx.query(
        `INSERT INTO coordinator_sessions("userId") SELECT DISTINCT "userId" FROM coordinator_events WHERE processed_at IS NULL AND wake_status IN ('pending','running') AND kind<>'issue_done' AND tier IN ('attention','result') AND ($1::text IS NULL OR "userId"=$1) ON CONFLICT DO NOTHING`,
        [onlyOwner ?? null],
      )
      const { rows: owners } = await tx.query(
        `SELECT s.* FROM coordinator_sessions s WHERE ($2::text IS NULL OR s."userId"=$2) AND (s."leaseUntil" IS NULL OR s."leaseUntil"<=$1) AND NOT EXISTS(SELECT 1 FROM coordinator_events a WHERE a."userId"=s."userId" AND a.processed_at IS NULL AND a.wake_lease_until>$1) AND EXISTS(SELECT 1 FROM coordinator_events e WHERE e."userId"=s."userId" AND e.processed_at IS NULL AND e.wake_status IN ('pending','running') AND e.kind<>'issue_done' AND e.tier IN ('attention','result') AND e.wake_next_at<=$1) ORDER BY s."updatedAt" LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
        [now, onlyOwner ?? null],
      )
      if (!owners.length) return null
      const owner = owners[0].userId as string
      const event = (
        await tx.query<WakeEvent>(
          `SELECT * FROM coordinator_events WHERE "userId"=$1 AND processed_at IS NULL AND wake_status IN ('pending','running') AND kind<>'issue_done' AND tier IN ('attention','result') AND wake_next_at<=$2 ORDER BY sequence LIMIT 1 FOR UPDATE`,
          [owner, now],
        )
      ).rows[0]
      if (!event) return null
      if (event.wake_generation_state === 'sending' && !event.wake_checkpoint) {
        await tx.query("UPDATE coordinator_events SET wake_generation_state='uncertain' WHERE id=$1", [event.id])
        await this.noteFailure(tx, event, 'wakeGenerationUncertain', 'failed')
        return { owner, exhausted: true as const }
      }
      if (event.wake_attempts >= (this.options.maxAttempts ?? 5)) {
        await this.noteFailure(tx, event, 'wakeRetriesExhausted')
        return { owner, exhausted: true as const }
      }
      const token = randomUUID(),
        until = new Date(now.getTime() + (this.options.deliveryLeaseMs ?? 60000))
      await tx.query(
        `UPDATE coordinator_events SET wake_status='pending',wake_delivery_token=$2,wake_attempts=wake_attempts+1,wake_total_attempts=wake_total_attempts+1,wake_lease_until=$3,processing_holder=NULL WHERE id=$1`,
        [event.id, token, until],
      )
      await tx.query(
        'UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL,active_event_id=NULL,"updatedAt"=$2 WHERE "userId"=$1',
        [owner, now],
      )
      return { owner, delivery: { eventId: event.id, token } }
    })
    if (!reservation || !('delivery' in reservation)) return reservation
    const { owner, delivery } = reservation
    try {
      const verify = () =>
        this.scoped(owner, delivery.eventId, 'dispatch', async (tx) => {
          await this.session(tx, owner)
          const event = (
            await tx.query<WakeEvent>(
              'SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND wake_delivery_token=$3 AND processed_at IS NULL FOR UPDATE',
              [delivery.eventId, owner, delivery.token],
            )
          ).rows[0]
          if (!event) throw new WakeError('wakeLeaseLost')
          const mode = await this.authorize(tx, event, 'dispatch')
          return { event, mode }
        })
      const { event, mode } = await verify()
      // Resource adapters may acquire their own pools/ledgers. Never invoke one
      // while holding an app/session/workspace transaction.
      // A persisted result or deterministic stop notice sends no model request.
      // It still passes the same current authority and publication fences.
      const admission =
        event.wake_checkpoint || mode === 'notify_only'
          ? { admitted: true as const }
          : await this.admission(event, 'dispatch')
      if (!admission.admitted) {
        await this.defer(owner, delivery, admission.retryAt)
        return { owner, deferred: true as const }
      }
      await verify()
      return reservation
    } catch (error) {
      if (!(error instanceof WakeError) || error.status !== 403) throw error
      await this.tx(async (tx) => {
        await this.session(tx, owner)
        const event = (
          await tx.query<WakeEvent>(
            'SELECT * FROM coordinator_events WHERE id=$1 AND wake_delivery_token=$2 FOR UPDATE',
            [delivery.eventId, delivery.token],
          )
        ).rows[0]
        if (event) await this.noteFailure(tx, event, error.code, true)
      })
      return { owner, exhausted: true as const }
    }
  }
  private async defer(owner: string, delivery: WakeDelivery, retryAt: Date, holder?: string) {
    return this.tx(async (tx) => {
      await this.session(tx, owner)
      const result = await tx.query(
        `UPDATE coordinator_events SET wake_status='pending',wake_error='wakeAdmissionDeferred',wake_next_at=$4,wake_attempts=GREATEST(0,wake_attempts-1),wake_lease_until=NULL,processing_holder=NULL WHERE id=$1 AND "userId"=$2 AND wake_delivery_token=$3 AND processed_at IS NULL AND ($5::text IS NULL OR processing_holder=$5) RETURNING id`,
        [delivery.eventId, owner, delivery.token, retryAt, holder ?? null],
      )
      if (result.rowCount)
        await tx.query(
          `UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL,active_event_id=NULL,"lastError"='Resource admission unavailable or deferred; no model request was sent.',"lastErrorAt"=$2 WHERE "userId"=$1 AND (active_event_id=$3 OR active_event_id IS NULL)`,
          [owner, this.clock(), delivery.eventId],
        )
    })
  }

  async deferTriage(owner: string, id: string, retryAt: Date) {
    return this.tx(async (tx) => {
      await this.session(tx, owner)
      await tx.query(
        `UPDATE coordinator_events SET wake_next_at=$3,wake_error='wakeAdmissionDeferred' WHERE id=$1 AND "userId"=$2 AND tier IS NULL AND "deliveredAt" IS NULL AND processed_at IS NULL AND wake_status IN ('pending','running')`,
        [id, owner, retryAt],
      )
    })
  }
  async denyTriage(owner: string, id: string, code: string) {
    return this.tx(async (tx) => {
      await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>(
          `SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND tier IS NULL AND "deliveredAt" IS NULL AND processed_at IS NULL AND wake_status IN ('pending','running') FOR UPDATE`,
          [id, owner],
        )
      ).rows[0]
      if (event) await this.noteFailure(tx, event, code, true)
    })
  }
  async delivered(owner: string, delivery: WakeDelivery, runId?: string) {
    await this.pool.query(
      `UPDATE coordinator_events SET wake_transport_run_id=COALESCE($4,wake_transport_run_id),wake_error=CASE WHEN wake_error='wakeAdmissionDeferred' THEN wake_error ELSE NULL END,wake_next_at=GREATEST(wake_next_at,$5::timestamptz) WHERE id=$1 AND "userId"=$2 AND wake_delivery_token=$3 AND processed_at IS NULL`,
      [
        delivery.eventId,
        owner,
        delivery.token,
        runId ?? null,
        new Date(this.clock().getTime() + (this.options.deliveryLeaseMs ?? 60000)),
      ],
    )
  }
  async deliveryFailed(owner: string, delivery: WakeDelivery) {
    return this.tx(async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>(
          'SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND wake_delivery_token=$3 AND processed_at IS NULL FOR UPDATE',
          [delivery.eventId, owner, delivery.token],
        )
      ).rows[0]
      if (!event || event.wake_error === 'wakeAdmissionDeferred') return
      // Lost ACK must not release or reopen a consumer that has already started.
      if (session.leaseUntil && session.leaseUntil > this.clock() && event.processing_holder === session.leaseHolder) {
        await tx.query("UPDATE coordinator_events SET wake_error='wakeTransportUnconfirmed' WHERE id=$1", [event.id])
        return
      }
      await this.noteFailure(tx, event, 'wakeTransportUnconfirmed')
    })
  }
  async take(owner: string, holder: string, delivery?: WakeDelivery): Promise<InboxReceipt> {
    const id =
      delivery?.eventId ??
      (
        await this.pool.query(
          "SELECT id FROM coordinator_events WHERE \"userId\"=$1 AND processed_at IS NULL AND wake_status IN ('pending','running') AND kind<>'issue_done' AND (tier IS NULL OR tier<>'background') ORDER BY sequence LIMIT 1",
          [owner],
        )
      ).rows[0]?.id
    if (!id) return { held: false, added: 0 }
    return this.scoped(owner, id, 'consume', async (tx) => {
      const session = await this.session(tx, owner),
        now = this.clock()
      if (session.leaseUntil && session.leaseUntil > now && session.leaseHolder !== holder)
        return { held: false, added: 0 }
      let event: WakeEvent | undefined
      if (delivery)
        event = (
          await tx.query<WakeEvent>(
            'SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND wake_delivery_token=$3 FOR UPDATE',
            [delivery.eventId, owner, delivery.token],
          )
        ).rows[0]
      else
        event = (
          await tx.query<WakeEvent>(
            `SELECT * FROM coordinator_events WHERE "userId"=$1 AND processed_at IS NULL AND wake_status IN ('pending','running') AND kind<>'issue_done' AND (tier IS NULL OR tier<>'background') ORDER BY sequence LIMIT 1 FOR UPDATE`,
            [owner],
          )
        ).rows[0]
      if (!event || event.processed_at || !['pending', 'running'].includes(event.wake_status))
        return { held: false, added: 0 }
      if (delivery && !foreground(event)) {
        await tx.query(
          'UPDATE coordinator_events SET wake_lease_until=NULL,wake_delivery_token=NULL,processing_holder=NULL WHERE id=$1',
          [event.id],
        )
        if (session.active_event_id === event.id)
          await tx.query(
            'UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL,active_event_id=NULL WHERE "userId"=$1',
            [owner],
          )
        return { held: false, added: 0 }
      }
      let mode: 'normal' | 'notify_only'
      try {
        mode = await this.authorize(tx, event, 'consume')
      } catch (e) {
        if (!(e instanceof WakeError)) throw e
        await this.noteFailure(tx, event, e.code, true)
        return { held: false, added: 0 }
      }
      const recovery = Boolean(event.deliveredAt) || event.wake_attempts > 1 || event.wake_replays > 0
      const token = event.wake_delivery_token ?? randomUUID(),
        receipt = { eventId: event.id, token }
      await tx.query(
        'UPDATE coordinator_sessions SET "leaseHolder"=$2,"leaseUntil"=$3,active_event_id=$4,"updatedAt"=$5 WHERE "userId"=$1',
        [owner, holder, new Date(now.getTime() + (this.options.leaseMs ?? 600000)), event.id, now],
      )
      // A stop notice takes no fresh background work, but rotates the fence of
      // children already staged with this event so its ACK cannot orphan them.
      const background = (
        await tx.query<WakeEvent>(
          `SELECT * FROM coordinator_events WHERE "userId"=$1 AND id<>$2 AND processed_at IS NULL AND wake_status IN ('pending','running') AND wake_workspace_id IS NOT DISTINCT FROM $3::uuid AND (wake_parent_id=$2 OR ($4::boolean AND wake_parent_id IS NULL AND "deliveredAt" IS NULL AND (tier='background' OR kind='issue_done'))) ORDER BY sequence LIMIT 49 FOR UPDATE`,
          [owner, event.id, event.wake_workspace_id, mode !== 'notify_only'],
        )
      ).rows
      const events = [event, ...background]
      let added = 0
      for (const item of events) {
        if (item.id !== event.id) {
          try {
            await this.authorize(tx, item, 'consume')
          } catch (e) {
            if (!(e instanceof WakeError)) throw e
            await this.noteFailure(tx, item, e.code, true)
            continue
          }
        }
        added++
        if (!item.deliveredAt) {
          const position = (
            await tx.query('SELECT COALESCE(MAX(position),0)+1 n FROM coordinator_messages WHERE "userId"=$1', [owner])
          ).rows[0].n
          await tx.query(
            `INSERT INTO coordinator_messages(id,"userId",position,message,source_event_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
            [
              factoryEventId('coordinator-input', item.id),
              owner,
              position,
              { role: 'user', content: eventPrompt(item) },
              item.id,
            ],
          )
        }
        await tx.query(
          `UPDATE coordinator_events SET "deliveredAt"=COALESCE("deliveredAt",$2),wake_status='running',processing_holder=$3,wake_delivery_token=$4,wake_parent_id=$5,wake_attempts=GREATEST(wake_attempts,1) WHERE id=$1`,
          [item.id, now, holder, token, item.id === event.id ? null : event.id],
        )
      }
      if (event.kind === 'user_message' && !event.accountActionBatch)
        await tx.query('UPDATE coordinator_events SET "accountActionBatch"=$2 WHERE id=$1', [
          event.id,
          { holder, closed: false, batches: [] },
        ])
      const actionContext = event.kind === 'user_message' ? { sourceEventId: event.id, holder, recovery } : undefined
      return {
        held: true,
        added,
        delivery: receipt,
        operationId: event.id,
        recovery,
        notifyOnly: mode === 'notify_only',
        notification: eventPrompt(event),
        hasCheckpoint: Boolean(event.wake_checkpoint),
        actionContext,
      }
    })
  }
  async assertCurrent(owner: string, holder: string, delivery: WakeDelivery) {
    return this.scoped(owner, delivery.eventId, 'commit', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          delivery.eventId,
          owner,
        ])
      ).rows[0]
      if (
        !event ||
        event.processed_at ||
        event.wake_delivery_token !== delivery.token ||
        event.processing_holder !== holder ||
        session.leaseHolder !== holder ||
        !session.leaseUntil ||
        session.leaseUntil <= this.clock()
      )
        throw new WakeError('wakeLeaseLost')
      if (!foreground(event)) throw new WakeError('wakeNotForeground')
      if ((await this.authorize(tx, event, 'commit')) === 'notify_only') throw new WakeError('wakeRunStopped')
      return event
    })
  }
  /** The effect and its receipt share the fresh session/event fence transaction.
   * This runs inside the actual effect step, never as a cached preflight step. */
  async effect<T>(owner: string, execution: WakeExecution, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    if (!/^step_[A-Za-z0-9_-]{1,160}$/.test(execution.operationKey) || !/^[a-f0-9]{64}$/.test(execution.binding))
      throw new WakeError('wakeEffectBindingInvalid')
    return this.scoped(owner, execution.delivery.eventId, 'commit', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          execution.delivery.eventId,
          owner,
        ])
      ).rows[0]
      if (
        !event ||
        event.processed_at ||
        !['pending', 'running'].includes(event.wake_status) ||
        event.wake_delivery_token !== execution.delivery.token ||
        event.processing_holder !== execution.holder ||
        session.leaseHolder !== execution.holder ||
        !session.leaseUntil ||
        session.leaseUntil <= this.clock()
      )
        throw new WakeError('wakeLeaseLost')
      if (!foreground(event)) throw new WakeError('wakeNotForeground')
      if ((await this.authorize(tx, event, 'commit')) === 'notify_only') throw new WakeError('wakeRunStopped')
      const receipts = event.wake_tool_receipts ?? {},
        prior = receipts[execution.operationKey]
      if (prior) {
        if (prior.binding !== execution.binding) throw new WakeError('wakeEffectBindingConflict')
        return prior.value as T
      }
      if (Object.keys(receipts).length >= 128) throw new WakeError('wakeEffectLimit')
      const value = await work(tx)
      await tx.query('UPDATE coordinator_events SET wake_tool_receipts=$2 WHERE id=$1', [
        event.id,
        { ...receipts, [execution.operationKey]: { binding: execution.binding, value } },
      ])
      return value
    })
  }
  async beginGeneration(owner: string, holder: string, delivery: WakeDelivery) {
    const before = await this.assertCurrent(owner, holder, delivery)
    if (before.wake_checkpoint) return { generate: false }
    const admission = await this.admission(before, 'consume')
    if (!admission.admitted) {
      await this.defer(owner, delivery, admission.retryAt, holder)
      return { generate: false, deferred: true }
    }
    return this.scoped(owner, delivery.eventId, 'commit', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          delivery.eventId,
          owner,
        ])
      ).rows[0]
      if (
        !event ||
        event.processed_at ||
        event.wake_delivery_token !== delivery.token ||
        event.processing_holder !== holder ||
        session.leaseHolder !== holder ||
        !session.leaseUntil ||
        session.leaseUntil <= this.clock()
      )
        throw new WakeError('wakeLeaseLost')
      if (!foreground(event)) throw new WakeError('wakeNotForeground')
      if ((await this.authorize(tx, event, 'commit')) === 'notify_only') throw new WakeError('wakeRunStopped')
      if (event.wake_checkpoint) return { generate: false }
      if (event.wake_generation_state !== 'not_started') throw new WakeError('wakeGenerationUncertain')
      await tx.query(
        "UPDATE coordinator_events SET wake_generation_state='sending',wake_generation_holder=$2 WHERE id=$1",
        [event.id, holder],
      )
      return { generate: true, operationId: event.id, generation: event.wake_replays }
    })
  }
  async checkpoint(
    owner: string,
    holder: string,
    delivery: WakeDelivery,
    messages: ModelMessage[],
    warning: string | null = null,
  ) {
    return this.scoped(owner, delivery.eventId, 'commit', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          delivery.eventId,
          owner,
        ])
      ).rows[0]
      if (!event) throw new WakeError('wakeNotFound', 404)
      if (event.processed_at) return
      if (
        event.wake_delivery_token !== delivery.token ||
        event.processing_holder !== holder ||
        session.leaseHolder !== holder ||
        !session.leaseUntil ||
        session.leaseUntil <= this.clock()
      )
        throw new WakeError('wakeLeaseLost')
      await this.authorize(tx, event, 'commit')
      const value = { messages, warning },
        digest = intentDigest(value)
      if (event.wake_checkpoint) {
        if (event.wake_checkpoint_digest !== digest) throw new WakeError('wakeCheckpointConflict')
        return
      }
      if (event.wake_generation_state === 'uncertain') throw new WakeError('wakeGenerationUncertain')
      await tx.query(
        "UPDATE coordinator_events SET wake_checkpoint=$2,wake_checkpoint_digest=$3,wake_generation_state='returned' WHERE id=$1",
        [event.id, value, digest],
      )
    })
  }
  async cached(owner: string, delivery: WakeDelivery) {
    const event = await this.read(owner, delivery.eventId)
    return event.wake_checkpoint
  }
  async acknowledge(
    owner: string,
    holder: string,
    delivery: WakeDelivery,
    messages: ModelMessage[],
    warning: string | null = null,
  ) {
    await this.checkpoint(owner, holder, delivery, messages, warning)
    return this.scoped(owner, delivery.eventId, 'commit', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          delivery.eventId,
          owner,
        ])
      ).rows[0]
      if (!event) throw new WakeError('wakeNotFound', 404)
      if (event.processed_at) return { replayed: true }
      if (
        event.wake_delivery_token !== delivery.token ||
        event.processing_holder !== holder ||
        session.leaseHolder !== holder ||
        !session.leaseUntil ||
        session.leaseUntil <= this.clock()
      )
        throw new WakeError('wakeLeaseLost')
      const mode = await this.authorize(tx, event, 'commit')
      const checkpoint = event.wake_checkpoint
      if (!checkpoint) throw new WakeError('wakeCheckpointRequired')
      const output: ModelMessage[] =
        mode === 'notify_only'
          ? [
              {
                role: 'assistant',
                content: `Run ${event.runId} is stopped or authorization was withdrawn; it has not been resumed.`,
              },
            ]
          : checkpoint.messages
      const children = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE wake_parent_id=$1 AND processed_at IS NULL', [
          event.id,
        ])
      ).rows
      for (const child of children) await this.authorize(tx, child, 'commit')
      let position = Number(
        (await tx.query('SELECT COALESCE(MAX(position),0)+1 n FROM coordinator_messages WHERE "userId"=$1', [owner]))
          .rows[0].n,
      )
      for (let index = 0; index < output.length; index++)
        await tx.query(
          `INSERT INTO coordinator_messages(id,"userId",position,message,source_event_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
          [factoryEventId(`coordinator-output:${index}`, event.id), owner, position++, output[index], event.id],
        )
      await tx.query(
        `UPDATE coordinator_events SET processed_at=$3,wake_status='completed',wake_error=NULL,wake_lease_until=NULL,"accountActionBatch"=CASE WHEN "accountActionBatch" IS NULL THEN NULL ELSE jsonb_set("accountActionBatch",'{closed}','true') END WHERE "userId"=$1 AND (id=$2 OR wake_parent_id=$2) AND processing_holder=$4 AND wake_delivery_token=$5`,
        [owner, event.id, this.clock(), holder, delivery.token],
      )
      await tx.query(
        'UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL,active_event_id=NULL,"lastError"=$2,"lastErrorAt"=$3,"updatedAt"=$4 WHERE "userId"=$1',
        [owner, checkpoint.warning, checkpoint.warning ? this.clock() : null, this.clock()],
      )
      return { replayed: false }
    })
  }
  async fail(owner: string, holder: string, delivery: WakeDelivery) {
    return this.tx(async (tx) => {
      await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>(
          'SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND processing_holder=$3 AND wake_delivery_token=$4 AND processed_at IS NULL FOR UPDATE',
          [delivery.eventId, owner, holder, delivery.token],
        )
      ).rows[0]
      if (event) {
        if (event.wake_generation_state === 'sending' && !event.wake_checkpoint) {
          await tx.query("UPDATE coordinator_events SET wake_generation_state='uncertain' WHERE id=$1", [event.id])
          await this.noteFailure(tx, event, 'wakeGenerationUncertain', 'failed')
        } else await this.noteFailure(tx, event, 'coordinatorTurnUnavailable')
      }
    })
  }
  async read(owner: string, eventId: string) {
    return this.scoped(owner, eventId, 'read', async (tx) => {
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2', [eventId, owner])
      ).rows[0]
      if (!event) throw new WakeError('wakeNotFound', 404)
      await this.authorize(tx, event, 'read')
      return event
    })
  }
  async replay(owner: string, eventId: string, expectedGeneration: number) {
    return this.scoped(owner, eventId, 'replay', async (tx) => {
      const session = await this.session(tx, owner)
      const event = (
        await tx.query<WakeEvent>('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [
          eventId,
          owner,
        ])
      ).rows[0]
      if (!event) throw new WakeError('wakeNotFound', 404)
      await this.authorize(tx, event, 'replay')
      if (event.wake_generation_state === 'uncertain') throw new WakeError('wakeReconciliationRequired')
      if (event.wake_status === 'legacy_review') throw new WakeError('wakeReconciliationRequired')
      if (
        event.wake_status !== 'failed' ||
        event.wake_replays !== expectedGeneration ||
        (session.leaseUntil && session.leaseUntil > this.clock())
      )
        throw new WakeError('wakeReplayConflict')
      await tx.query(
        `UPDATE coordinator_events SET wake_status='pending',wake_attempts=0,wake_replays=wake_replays+1,wake_next_at=$2,wake_error=NULL,wake_delivery_token=NULL,wake_lease_until=NULL,processing_holder=NULL WHERE id=$1`,
        [event.id, this.clock()],
      )
      return { eventId: event.id, generation: event.wake_replays + 1, operationId: event.id }
    })
  }
  async active(owner: string) {
    return (await this.pool.query('SELECT active_event_id FROM coordinator_sessions WHERE "userId"=$1', [owner]))
      .rows[0]?.active_event_id as string | undefined
  }
}
