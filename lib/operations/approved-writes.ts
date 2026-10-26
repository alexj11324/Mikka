import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { parseWriteInput, type WriteActionName, writeTarget } from './write-contract'
import { createOperationLedger, lockOperation, OperationError, type OperationIntent, type OperationRecord } from './ledger'
import { requireOperationSession, withOperationSession } from './session-authorization'
import type { WriteProvider } from './write-contract'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const bindingSchema = z.object({ accountId: z.string().min(1), version: z.string().min(1), provider: z.string().min(1), payloadDigest: z.string().length(64), contextDigest: z.string().length(64) }).strict()
interface Proposal { id: string; userId: string; action: string; input: Record<string, unknown>; status: string; operationBinding: z.infer<typeof bindingSchema>; intentKey: string; context: Record<string, unknown> | null }
// #204 acts in a person's own account, not a team workspace. Explicit personal
// scope avoids inventing a workspace DB relationship or using a browser cookie.
const scope = (owner: string) => `personal:${owner}`
const identity = (p: Proposal) => ({ operationId: p.id, ownerId: p.userId, workspaceId: scope(p.userId) })
const intent = (p: Proposal): OperationIntent => ({ ...identity(p), provider: p.operationBinding.provider, accountId: p.operationBinding.accountId, action: p.action, target: writeTarget(p.action as WriteActionName, p.input), approvalId: p.id, proposalDigest: digest([p.action, p.operationBinding]), payloadDigest: p.operationBinding.payloadDigest })

async function bounded<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([call(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OperationError('operationUncertain')) }, 30000) })]) }
  finally { clearTimeout(timer) }
}

export function createApprovedWrites(pool: Pool, provider: WriteProvider, action: WriteActionName) {
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async function owned(tx: PoolClient, owner: string, id: string) {
    const { rows } = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [id, owner])
    const row = rows[0]
    if (!row || row.action !== action || !row.operationBinding) throw new OperationError('pendingActionUnavailable')
    bindingSchema.parse(row.operationBinding)
    if (digest(row.input) !== row.operationBinding.payloadDigest || digest(row.context) !== row.operationBinding.contextDigest) throw new OperationError('operationBindingConflict')
    return row
  }
  async function current(tx: PoolClient, binding: OperationIntent, _run: string | null, phase: string) {
    const p = await owned(tx, binding.ownerId, binding.approvalId)
    if (JSON.stringify(intent(p)) !== JSON.stringify(binding)) {
      // Compare fields canonically; JSONB object key order is not application order.
      for (const [key, value] of Object.entries(intent(p))) if (binding[key as keyof OperationIntent] !== value) throw new OperationError('operationBindingConflict')
    }
    const valid = await tx.query(`SELECT id FROM pending_actions WHERE id=$1 AND status IN ('running','done') AND ($2=false OR "createdAt">clock_timestamp()-interval '7 days')`, [p.id, ['claim', 'invoke'].includes(phase)])
    if (!valid.rows.length || p.operationBinding.provider !== provider.name) throw new OperationError('pendingActionUnavailable')
  }
  async function project(row: OperationRecord) {
    // UI-compatible projection. Unknown results are never represented as failure
    // or success: existing running stays pending reconciliation; ledger is authoritative.
    if (row.status === 'succeeded') await pool.query(`UPDATE pending_actions SET status='done',result=$2,error=NULL WHERE id=$1 AND status IN ('running','done')`, [row.operationId, { id: row.receipt!.providerObjectId }])
    return { status: row.status === 'succeeded' ? 'done' as const : 'running' as const, error: row.status === 'succeeded' ? null : 'operationUncertain' }
  }
  return {
    async propose(owner: string, raw: unknown, intentKey: string) {
      z.uuid().parse(intentKey)
      const input = parseWriteInput(action, raw)
      if (!input) throw new OperationError('invalidIntegrationInput')
      const hash = digest(input)
      // Serialize by trusted durable step identity before resolving account. Replay
      // returns original proposal even if accounts changed; execution rechecks it.
      return transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-intent', owner, intentKey])])
        const prior = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE "userId"=$1 AND "intentKey"=$2', [owner, intentKey])
        if (prior.rows[0]) {
          const p = prior.rows[0]
          if (p.action !== action || p.operationBinding?.payloadDigest !== hash) throw new OperationError('operationBindingConflict')
          return { status: p.status === 'pending' ? 'awaiting_approval' : p.status, actionId: p.id }
        }
        const count = await tx.query(`SELECT count(*) FROM pending_actions WHERE "userId"=$1 AND status='pending' AND "createdAt">clock_timestamp()-interval '7 days'`, [owner])
        if (Number(count.rows[0].count) >= 20) throw new OperationError('tooManyPendingActions')
        const selected = await bounded(() => provider.prepare(owner, input))
        const binding = bindingSchema.parse({ accountId: selected.accountId, version: selected.version, provider: provider.name, payloadDigest: hash, contextDigest: digest(selected.context ?? null) })
        const id = randomUUID()
        await tx.query('INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context) VALUES ($1,$2,$6,$3,$4,$5,$7)', [id, owner, input, intentKey, binding, action, selected.context ?? null])
        return { status: 'awaiting_approval', actionId: id }
      })
    },
    async decide(actor: { userId: string; sessionId: string }, id: string, approve: boolean) {
      z.uuid().parse(id)
      // All paths use ledger -> session -> proposal. Revocation waits for an
      // in-flight invoke and never reports cancellation of an already sent effect.
      const p = await transaction(async tx => {
        await lockOperation(tx, { operationId: id, ownerId: actor.userId, workspaceId: scope(actor.userId) })
        const execution = await tx.query('SELECT status,"invokedAt" FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2 FOR UPDATE', [id, actor.userId])
        await requireOperationSession(tx, actor, actor.userId)
        if (!approve) {
          if (execution.rows[0]?.invokedAt) throw new OperationError('operationUncertain')
          // Closing an uninvoked owned proposal does not authorize an effect.
          // Allow old bindings without contextDigest to be safely declined.
          const closed = await tx.query("UPDATE pending_actions SET status='declined',\"decidedAt\"=clock_timestamp() WHERE id=$1 AND \"userId\"=$2 AND action=$3 AND status IN ('pending','running') RETURNING id", [id, actor.userId, action])
          if (!closed.rows.length) throw new OperationError('pendingActionUnavailable')
          await requireOperationSession(tx, actor, actor.userId)
          return null
        }
        const row = await owned(tx, actor.userId, id)
        await requireOperationSession(tx, actor, actor.userId)
        const valid = await tx.query(`SELECT id FROM pending_actions WHERE id=$1 AND (status IN ('running','done') OR "createdAt">clock_timestamp()-interval '7 days')`, [id])
        if (!valid.rows.length) throw new OperationError('pendingActionUnavailable')
        if (!['pending', 'running', 'done'].includes(row.status)) throw new OperationError('pendingActionUnavailable')
        if (row.status === 'pending') await tx.query("UPDATE pending_actions SET status='running',\"decidedAt\"=clock_timestamp() WHERE id=$1", [id])
        return row
      })
      if (!p) return { status: 'declined' as const, error: null }
      const ledger = createOperationLedger(pool, withOperationSession(actor, current))
      const row = await ledger.reserve(intent(p))
      if (row.status !== 'reserved') {
        if (row.status === 'succeeded') return project(row)
        // A concurrent approval is not proof the first caller crashed. Negative
        // lookup must not invalidate its claim before invocation starts.
        const evidence = await bounded(() => provider.lookup({ ownerId: p.userId, accountId: p.operationBinding.accountId, idempotencyKey: row.idempotencyKey }))
        if (!evidence) return project(row)
        return project(await ledger.reconcile(identity(p), async () => evidence))
      }
      let claimed: OperationRecord
      try { claimed = await ledger.claim(identity(p), randomUUID()) }
      catch (error) {
        if (error instanceof OperationError && error.message === 'operationAlreadyClaimed') return project(await ledger.read(identity(p)))
        throw error
      }
      try {
        const result = await ledger.invoke(identity(p), claimed.attemptToken!, (record, beforeSend) => bounded(signal => provider.execute({ signal, beforeSend, ownerId: p.userId, ...p.operationBinding, payload: p.input, approvalContext: p.context, idempotencyKey: record.idempotencyKey })))
        return project(result)
      } catch {
        // The durable invoke gate survives provider/writeback failures. Never resend.
        return { status: 'running' as const, error: 'operationUncertain' }
      }
    },
  }
}
