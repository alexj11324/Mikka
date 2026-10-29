import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { writeTransaction, type WriteRequestContext, type WriteActor } from './write-transaction'
import { waitForMailboxGuard } from '@/lib/mailbox-transaction-guard'
import { WRITE_ACTIONS, parseWriteInput, type WriteActionName, writeTarget } from './write-contract'
import { createOperationLedger, lockOperation, OperationError, type OperationIntent, type OperationRecord } from './ledger'
import { requireOperationSession, withOperationSession } from './session-authorization'
import type { WriteProvider } from './write-contract'
import { writeBindingSchema as bindingSchema, prepareWriteBinding } from './write-binding'
import { lockWritePolicy } from './write-policy-store'
import { withWritePolicy } from './policy-authorization'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export interface StoredWriteProposal { id: string; userId: string; action: string; input: Record<string, unknown>; status: string; operationBinding: z.infer<typeof bindingSchema>; intentKey: string; context: Record<string, unknown> | null; createdAt: Date }
type Proposal = StoredWriteProposal
export interface ApprovedWriteView {
  id: string
  action: WriteActionName
  input: Record<string, unknown>
  approvalContext: Record<string, unknown> | null
  account: { provider: string; accountId: string; version: string }
  createdAt: string
  approvalExpiresAt: string
  status: 'pending' | 'running' | 'done' | 'declined'
  error: 'operationUncertain' | null
}
// #204 acts in a person's own account, not a team workspace. Explicit personal
// scope avoids inventing a workspace DB relationship or using a browser cookie.
const scope = (owner: string) => `personal:${owner}`
const identity = (p: Proposal) => ({ operationId: p.id, ownerId: p.userId, workspaceId: scope(p.userId) })
const intent = (p: Proposal): OperationIntent => ({ ...identity(p), provider: p.operationBinding.provider, accountId: p.operationBinding.accountId, action: p.action, target: writeTarget(p.action as WriteActionName, p.input), approvalId: p.id, proposalDigest: digest([p.action, p.operationBinding]), payloadDigest: p.operationBinding.payloadDigest, ...(p.operationBinding.run ? { executionRunId: p.operationBinding.run.runId, policyScope: { botId: p.operationBinding.run.botId, workspaceId: p.operationBinding.run.workspaceId, version: p.operationBinding.run.policyVersion } } : {}) })

/** Pure projection only; callers must authenticate/authorize the read separately.
 * Shared by by-ID and discovery so status never depends on which endpoint is used. */
export function projectApprovedWriteView(p: StoredWriteProposal, execution: (OperationRecord & { invokedAt: Date | string | null }) | null | undefined): ApprovedWriteView {
  const action = p.action as WriteActionName
  if (!WRITE_ACTIONS.includes(action) || !z.uuid().safeParse(p.intentKey).success || !bindingSchema.safeParse(p.operationBinding).success || !parseWriteInput(action, p.input) || !['pending', 'running', 'done', 'declined'].includes(p.status)) throw new OperationError('operationBindingConflict')
  if (digest(p.input) !== p.operationBinding.payloadDigest || digest(p.context) !== p.operationBinding.contextDigest || execution && digest(execution.binding) !== digest(intent(p))) throw new OperationError('operationBindingConflict')
  if (p.status === 'declined' && execution?.invokedAt || p.status === 'done' && execution?.status !== 'succeeded') throw new OperationError('operationBindingConflict')
  const status = p.status === 'declined' ? 'declined' : execution?.status === 'succeeded' ? 'done' : execution || p.status === 'running' ? 'running' : 'pending'
  const created = z.coerce.date().safeParse(p.createdAt)
  if (!created.success) throw new OperationError('operationBindingConflict')
  return {
    id: p.id, action, input: p.input, approvalContext: p.context,
    account: { provider: p.operationBinding.provider, accountId: p.operationBinding.accountId, version: p.operationBinding.version },
    createdAt: created.data.toISOString(), approvalExpiresAt: new Date(created.data.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status, error: status === 'running' ? 'operationUncertain' : null,
  }
}

async function bounded<T>(call: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await waitForMailboxGuard(Promise.race([call(requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OperationError('operationUncertain')) }, 30000) })]), requestSignal) }
  finally { clearTimeout(timer) }
}

export function createApprovedWrites(pool: Pool, provider: WriteProvider, action: WriteActionName, context: WriteRequestContext = {}) {
  function transaction<T>(work: (tx: PoolClient) => Promise<T>, actor: WriteActor | undefined = context.actor) {
    return writeTransaction(pool, work, { signal: context.signal, guard: context.guard, ...(actor ? { authorizeCommit: (tx: PoolClient) => requireOperationSession(tx, actor, actor.userId) } : {}) })
  }
  async function owned(tx: PoolClient, owner: string, id: string) {
    const { rows } = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [id, owner])
    const row = rows[0]
    if (!row || row.action !== action || !row.operationBinding) throw new OperationError('pendingActionUnavailable')
    const storedIntent = z.uuid().safeParse(row.intentKey)
    if (!storedIntent.success) throw new OperationError('operationBindingConflict')
    const canonicalIntent = storedIntent.data.toLowerCase()
    const aliases = await tx.query('SELECT id FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2 LIMIT 2', [owner, canonicalIntent])
    if (aliases.rows.length !== 1) throw new OperationError('operationIntentAmbiguous')
    if (!bindingSchema.safeParse(row.operationBinding).success) throw new OperationError('operationBindingConflict')
    if (digest(row.input) !== row.operationBinding.payloadDigest || digest(row.context) !== row.operationBinding.contextDigest) throw new OperationError('operationBindingConflict')
    return row
  }
  async function current(tx: PoolClient, binding: OperationIntent, _run: string | null, phase: string) {
    const p = await owned(tx, binding.ownerId, binding.approvalId)
    if (digest(intent(p)) !== digest(binding)) throw new OperationError('operationBindingConflict')
    if (binding.executionRunId && _run !== null && binding.executionRunId !== _run) throw new OperationError('operationRunMismatch')
    const valid = await tx.query(`SELECT id FROM pending_actions WHERE id=$1 AND status IN ('running','done') AND ($2=false OR "createdAt">clock_timestamp()-interval '7 days')`, [p.id, ['claim', 'invoke'].includes(phase)])
    if (!valid.rows.length || p.operationBinding.provider !== provider.name) throw new OperationError('pendingActionUnavailable')
  }
  async function project(row: OperationRecord) {
    // UI-compatible projection. Unknown results are never represented as failure
    // or success: existing running stays pending reconciliation; ledger is authoritative.
    if (row.status === 'succeeded') await pool.query(`UPDATE pending_actions SET status='done',result=$2,error=NULL WHERE id=$1 AND status IN ('running','done')`, [row.operationId, { id: row.receipt!.providerObjectId }])
    return { status: row.status === 'succeeded' ? 'done' as const : 'running' as const, error: row.status === 'succeeded' ? null : 'operationUncertain' }
  }
  async function execute(p: Proposal, actor?: WriteActor) {
      const run = p.operationBinding.run
      const guard = actor && run && context.guardForRun ? context.guardForRun({ ownerId: p.userId, botId: run.botId, workspaceId: run.workspaceId, runId: run.runId }) : context.guard
      if (run?.workspaceId && !guard) throw new OperationError('writePolicyUnavailable')
      const authorize = run ? withWritePolicy(current, async (tx, binding, runId, phase) => { if (!actor) throw new OperationError('writeApprovalRequired'); await current(tx, binding, runId, phase) }, { allowCompleted: Boolean(actor) }) : current
      if (!actor && !run) throw new OperationError('operationAuthorizationRequired')
      const ledger = createOperationLedger(pool, actor ? withOperationSession(actor, authorize) : authorize, { ...context, guard })
      const row = await ledger.reserve(intent(p))
      if (row.status !== 'reserved') {
        if (row.status === 'succeeded') return project(row)
        // A concurrent approval is not proof the first caller crashed. Negative
        // lookup must not invalidate its claim before invocation starts.
        const evidence = await bounded(() => provider.lookup({ ownerId: p.userId, accountId: p.operationBinding.accountId, idempotencyKey: row.idempotencyKey }), context.signal)
        if (!evidence) return project(row)
        return project(await ledger.reconcile(identity(p), async () => evidence))
      }
      let claimed: OperationRecord
      try { claimed = await ledger.claim(identity(p), run?.runId ?? randomUUID()) }
      catch (error) {
        if (error instanceof OperationError && error.message === 'operationAlreadyClaimed') return project(await ledger.read(identity(p)))
        throw error
      }
      try {
        const result = await ledger.invoke(identity(p), claimed.attemptToken!, (record, beforeSend, leaseSignal) => bounded(signal => provider.execute({ signal: AbortSignal.any([signal, leaseSignal]), beforeSend, ownerId: p.userId, ...p.operationBinding, payload: p.input, approvalContext: p.context, idempotencyKey: record.idempotencyKey }), context.signal))
        return project(result)
      } catch {
        // The durable invoke gate survives provider/writeback failures. Never resend.
        return { status: 'running' as const, error: 'operationUncertain' }
      }
  }
  return {
    async view(actor: { userId: string; sessionId: string }, id: string): Promise<ApprovedWriteView> {
      z.uuid().parse(id)
      return transaction(async tx => {
        // Same gate/lock order as decisions; only SELECTs, no reserve, projection
        // writeback, provider lookup, implicit approval or new execution authority.
        await lockOperation(tx, { operationId: id, ownerId: actor.userId, workspaceId: scope(actor.userId) })
        const result = await tx.query<OperationRecord & { invokedAt: Date | null }>('SELECT * FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [id, actor.userId, scope(actor.userId)])
        await requireOperationSession(tx, actor, actor.userId)
        const p = await owned(tx, actor.userId, id)
        const execution = result.rows[0]
        const view = projectApprovedWriteView(p, execution)
        await requireOperationSession(tx, actor, actor.userId)
        return view
      }, actor)
    },
    async propose(owner: string, raw: unknown, intentKey: string) {
      const canonicalIntentKey = z.uuid().parse(intentKey).toLowerCase()
      const input = parseWriteInput(action, raw)
      if (!input) throw new OperationError('invalidIntegrationInput')
      const hash = digest(input)
      // Read replay first, then resolve read-only metadata without APP locks.
      // The final transaction repeats intent/limit/session checks before INSERT.
      const locked = <T>(work: (tx: PoolClient) => Promise<T>) => transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-intent', owner, canonicalIntentKey])])
        return work(tx)
      })
      async function prior(tx: PoolClient) {
        const saved = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2', [owner, canonicalIntentKey])
        if (saved.rows.length > 1) throw new OperationError('operationIntentAmbiguous')
        const p = saved.rows[0]
        if (!p) return null
        if (p.action !== action || p.operationBinding?.payloadDigest !== hash) throw new OperationError('operationBindingConflict')
        return { status: p.status === 'pending' ? 'awaiting_approval' : p.status, actionId: p.id }
      }
      const existing = await locked(prior)
      if (existing) return existing
      const selected = await bounded(() => provider.prepare(owner, input), context.signal)
      const binding = prepareWriteBinding(provider.name, selected, input)
      return locked(async tx => {
        const winner = await prior(tx)
        if (winner) return winner
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-pending-owner', owner])])
        const count = await tx.query(`SELECT count(*) FROM pending_actions WHERE "userId"=$1 AND status='pending' AND "createdAt">clock_timestamp()-interval '7 days'`, [owner])
        if (Number(count.rows[0].count) >= 20) throw new OperationError('tooManyPendingActions')
        const id = randomUUID()
        await tx.query('INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context) VALUES ($1,$2,$6,$3,$4,$5,$7)', [id, owner, input, canonicalIntentKey, binding, action, selected.context ?? null])
        return { status: 'awaiting_approval', actionId: id }
      })
    },
    async proposeFromRun(raw: unknown, intentKey: string) {
      const run = context.modelRun
      if (!run || (run.workspaceId && !context.guard)) throw new OperationError('writePolicyUnavailable')
      const key = z.uuid().parse(intentKey).toLowerCase()
      const input = parseWriteInput(action, raw)
      if (!input) throw new OperationError('invalidIntegrationInput')
      const hash = digest(input)
      const locked = <T>(work: (tx: PoolClient) => Promise<T>) => transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-intent', run.ownerId, key])])
        return work(tx)
      })
      const prior = async (tx: PoolClient) => {
        const rows = await tx.query<Proposal>('SELECT * FROM pending_actions WHERE "userId"=$1 AND lower("intentKey")=$2', [run.ownerId, key])
        if (rows.rows.length > 1) throw new OperationError('operationIntentAmbiguous')
        const p = rows.rows[0]
        if (p && (p.action !== action || p.operationBinding?.payloadDigest !== hash || p.operationBinding?.run?.runId !== run.runId || p.operationBinding.run.botId !== run.botId || p.operationBinding.run.workspaceId !== run.workspaceId)) throw new OperationError('operationBindingConflict')
        return p ?? null
      }
      let proposal = await locked(prior)
      if (!proposal) {
        // Check authorization before provider metadata and recheck under the insert lock.
        const first = await transaction(tx => lockWritePolicy(tx, { ...run, action }))
        if (first.decision === 'deny') throw new OperationError('writeDenied')
        const selected = await bounded(() => provider.prepare(run.ownerId, input), context.signal)
        proposal = await locked(async tx => {
          const existing = await prior(tx)
          if (existing) return existing
          const policy = await lockWritePolicy(tx, { ...run, action })
          if (policy.version !== first.version || policy.decision !== first.decision) throw new OperationError('writePolicyChanged')
          if (policy.decision === 'deny') throw new OperationError('writeDenied')
          if (policy.decision === 'ask') {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['approved-write-pending-owner', run.ownerId])])
            const count = await tx.query(`SELECT count(*) FROM pending_actions WHERE "userId"=$1 AND status='pending' AND "createdAt">clock_timestamp()-interval '7 days'`, [run.ownerId])
            if (Number(count.rows[0].count) >= 20) throw new OperationError('tooManyPendingActions')
          }
          const binding = bindingSchema.parse({ ...prepareWriteBinding(provider.name, selected, input), run: { runId:run.runId, botId:run.botId, workspaceId:run.workspaceId, policyVersion:policy.version, decision:policy.decision } })
          const id = randomUUID(), status = policy.decision === 'allow' ? 'running' : 'pending'
          const inserted = await tx.query<Proposal>('INSERT INTO pending_actions (id,"userId",action,input,"intentKey","operationBinding",context,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [id, run.ownerId, action, input, key, binding, selected.context ?? null, status])
          return inserted.rows[0]
        })
      }
      if (proposal.status === 'pending') return { status:'awaiting_approval' as const, actionId:proposal.id }
      if (proposal.status === 'declined') return { status:'declined' as const, actionId:proposal.id }
      if (proposal.operationBinding.run?.decision !== 'allow') return { status:proposal.status, actionId:proposal.id }
      return { ...(await execute(proposal)), actionId:proposal.id }
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
        if (row.operationBinding.run) {
          const r = row.operationBinding.run
          const policy = await lockWritePolicy(tx, { ownerId:actor.userId, botId:r.botId, workspaceId:r.workspaceId, runId:r.runId, action }, { allowCompleted:true })
          if (policy.decision === 'deny') throw new OperationError('writeDenied')
          if (policy.version !== r.policyVersion || policy.decision !== r.decision) throw new OperationError('writePolicyChanged')
        }
        await requireOperationSession(tx, actor, actor.userId)
        const valid = await tx.query(`SELECT id FROM pending_actions WHERE id=$1 AND (status IN ('running','done') OR "createdAt">clock_timestamp()-interval '7 days')`, [id])
        if (!valid.rows.length) throw new OperationError('pendingActionUnavailable')
        if (!['pending', 'running', 'done'].includes(row.status)) throw new OperationError('pendingActionUnavailable')
        if (row.status === 'pending') await tx.query("UPDATE pending_actions SET status='running',\"decidedAt\"=clock_timestamp() WHERE id=$1", [id])
        return row
      }, actor)
      if (!p) return { status: 'declined' as const, error: null }
      return execute(p, actor)
    },
  }
}
