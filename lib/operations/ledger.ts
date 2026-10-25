import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

const text = z.string().min(1).max(500)
const identity = z.object({ operationId: z.uuid(), ownerId: text, workspaceId: text }).strict()
/** Trusted callers persist operationId with the logical intent, before any run attempt. */
const intent = identity.extend({
  provider: text, accountId: text, action: text, target: text,
  approvalId: text, candidateSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => Boolean(value.candidateSha) !== Boolean(value.proposalDigest), 'exactly one candidate or proposal binding required')
const receiptSchema = z.object({ providerObjectId: text, evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type OperationIdentity = z.infer<typeof identity>
export type OperationIntent = z.infer<typeof intent>
export type OperationReceipt = z.infer<typeof receiptSchema>
export interface OperationRecord extends OperationIdentity {
  binding: OperationIntent
  idempotencyKey: string
  status: 'reserved' | 'executing' | 'succeeded' | 'failed' | 'uncertain'
  attemptToken: string | null
  runId: string | null
  receipt: OperationReceipt | null
}
export class OperationError extends Error {}
/** Must check current tenant access, approval, candidate and attempt fence using tx.
 * Authorization rows must be locked against concurrent revocation. No permissive default.
 * A returned receipt records historical fact, not permission for another effect.
 */
export type OperationAuthorize = (tx: PoolClient, binding: OperationIntent, runId: string | null, phase: 'reserve' | 'claim' | 'read' | 'settle' | 'reconcile' | 'invoke') => Promise<void>

export function createOperationLedger(pool: Pool, authorize: OperationAuthorize) {
  if (typeof authorize !== 'function') throw new OperationError('operationAuthorizationRequired')
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async function owned(tx: PoolClient, input: OperationIdentity): Promise<OperationRecord> {
    const key = identity.parse(input)
    const { rows } = await tx.query<OperationRecord>('SELECT * FROM operation_ledger WHERE "operationId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [key.operationId, key.ownerId, key.workspaceId])
    if (!rows[0]) throw new OperationError('operationUnavailable')
    return rows[0]
  }
  return {
    async reserve(input: OperationIntent) {
      const binding = intent.parse(input)
      return transaction(async tx => {
        const key = createHash('sha256').update(JSON.stringify(['mikka-operation-v1', binding.ownerId, binding.workspaceId, binding.operationId])).digest('hex')
        await tx.query('INSERT INTO operation_ledger ("operationId","ownerId","workspaceId",binding,"idempotencyKey") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [binding.operationId, binding.ownerId, binding.workspaceId, binding, key])
        const row = await owned(tx, { operationId: binding.operationId, ownerId: binding.ownerId, workspaceId: binding.workspaceId })
        await authorize(tx, row.binding, null, 'reserve')
        if (JSON.stringify(intent.parse(row.binding)) !== JSON.stringify(binding)) throw new OperationError('operationBindingConflict')
        return row
      })
    },
    async read(input: OperationIdentity) {
      return transaction(async tx => { const row = await owned(tx, input); await authorize(tx, row.binding, row.runId, 'read'); return row })
    },
    async claim(input: OperationIdentity, runId: string) {
      z.uuid().parse(runId)
      return transaction(async tx => {
        const row = await owned(tx, input)
        await authorize(tx, row.binding, runId, 'claim')
        if (row.status !== 'reserved') throw new OperationError('operationAlreadyClaimed')
        const { rows } = await tx.query<OperationRecord>('UPDATE operation_ledger SET status=\'executing\',"attemptToken"=$2,"runId"=$3,"updatedAt"=clock_timestamp() WHERE "operationId"=$1 RETURNING *', [row.operationId, randomUUID(), runId])
        return rows[0]
      })
    },
    /** One durable invocation gate per claim; locks current authority through the
     * bounded provider call. A crash after the gate commits requires reconciliation.
     * Callers never receive an authority to invoke again after an unknown result.
     */
    async invoke(input: OperationIdentity, attemptToken: string, execute: (record: Readonly<OperationRecord>, beforeSend: () => Promise<void>) => Promise<OperationReceipt>) {
      z.uuid().parse(attemptToken)
      await transaction(async tx => {
        const row = await owned(tx, input)
        await authorize(tx, row.binding, row.runId, 'invoke')
        if (row.attemptToken !== attemptToken || row.status !== 'executing') throw new OperationError('operationStaleAttempt')
        const result = await tx.query('UPDATE operation_ledger SET "invokedAt"=clock_timestamp() WHERE "operationId"=$1 AND "invokedAt" IS NULL', [row.operationId])
        if (!result.rowCount) throw new OperationError('operationAlreadyInvoked')
      })
      return transaction(async tx => {
        const row = await owned(tx, input)
        if (row.attemptToken !== attemptToken || row.status !== 'executing') throw new OperationError('operationStaleAttempt')
        await authorize(tx, row.binding, row.runId, 'invoke')
        const receipt = receiptSchema.parse(await execute(row, () => authorize(tx, row.binding, row.runId, 'invoke')))
        const { rows } = await tx.query<OperationRecord>('UPDATE operation_ledger SET status=\'succeeded\',receipt=$2,"updatedAt"=clock_timestamp() WHERE "operationId"=$1 RETURNING *', [row.operationId, receipt])
        return rows[0]
      })
    },
    /** Commit executing BEFORE contacting a provider. No automatic reclaim or retry.
     * failed means a trusted adapter has definitive evidence of no effect.
     * Timeouts, disconnects and writeback failures must remain executing/uncertain.
     */
    async settle(input: OperationIdentity, attemptToken: string, outcome: { status: 'succeeded'; receipt: OperationReceipt } | { status: 'failed' | 'uncertain' }) {
      z.uuid().parse(attemptToken)
      const receipt = outcome.status === 'succeeded' ? receiptSchema.parse(outcome.receipt) : null
      z.enum(['succeeded', 'failed', 'uncertain']).parse(outcome.status)
      return transaction(async tx => {
        const row = await owned(tx, input)
        await authorize(tx, row.binding, row.runId, 'settle')
        if (row.attemptToken !== attemptToken || row.status !== 'executing') throw new OperationError('operationStaleAttempt')
        const { rows } = await tx.query<OperationRecord>('UPDATE operation_ledger SET status=$2,receipt=$3,"updatedAt"=clock_timestamp() WHERE "operationId"=$1 RETURNING *', [row.operationId, outcome.status, receipt])
        return rows[0]
      })
    },
    /** Trusted readback only; never invokes an effect. Unknown/absent objects stay uncertain:
     * a negative query cannot prove an old in-flight request will not later complete.
     */
    async reconcile(input: OperationIdentity, lookup: (record: Readonly<OperationRecord>) => Promise<OperationReceipt | null>) {
      return transaction(async tx => {
        const row = await owned(tx, input)
        await authorize(tx, row.binding, row.runId, 'reconcile')
        if (!['executing', 'uncertain'].includes(row.status)) return row
        const evidence = await lookup(row)
        const receipt = evidence === null ? null : receiptSchema.parse(evidence)
        const { rows } = await tx.query<OperationRecord>('UPDATE operation_ledger SET status=$2,receipt=$3,"updatedAt"=clock_timestamp() WHERE "operationId"=$1 RETURNING *', [row.operationId, receipt ? 'succeeded' : 'uncertain', receipt])
        return rows[0]
      })
    },
  }
}
