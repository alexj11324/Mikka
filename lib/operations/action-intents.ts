import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { parseActionInput } from '../composio-actions'
import { OperationError } from './ledger'
import type { AccountActionRef } from '../../packages/protocol/src/device'

export type ActionContext = { sourceEventId: string; holder: string; recovery?: boolean }
type Call = { toolCallId: string; toolName: string; input: unknown }
type Slot = { actionSlotId: string; toolCallId: string; input: Record<string, unknown> }
export type ActionBatch = { holder: string; closed: boolean; batches: { callsDigest: string; slots: Slot[] }[] }
export const intentKeyForSlot = (sourceEventId: string, actionSlotId: string) => `event:${sourceEventId}:slot:${actionSlotId}`
export const intentDigest = (value: unknown): string => {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
const fail = (code: string): never => { throw new OperationError(code) }
export async function actionRefsForSource(tx: Pick<PoolClient, 'query'>, owner: string, sourceEventId: string): Promise<AccountActionRef[]> {
  const { rows } = await tx.query(`SELECT id,"sourceEventId","actionSlotId",action,"operationBinding" FROM pending_actions WHERE "userId"=$1 AND "sourceEventId"=$2 ORDER BY "actionSlotId"`, [owner, sourceEventId])
  return rows.map(p => ({ sourceEventId: p.sourceEventId, actionSlotId: p.actionSlotId, operationId: p.id, proposalDigest: intentDigest([p.action, p.operationBinding]) }))
}
export function createActionIntents(pool: Pool) {
  async function transaction<T>(fn: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async function source(tx: PoolClient, owner: string, context: ActionContext) {
    z.uuid().parse(context.sourceEventId)
    // Same lock order as takeInbox/appendMessages. A string alone is never authority.
    const lease = await tx.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "leaseHolder"=$2 AND "leaseUntil">clock_timestamp() FOR UPDATE', [owner, context.holder])
    if (!lease.rows.length) fail('accountActionLeaseLost')
    const { rows } = await tx.query('SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 FOR UPDATE', [context.sourceEventId, owner])
    if (!rows[0] || rows[0].kind !== 'user_message' || !rows[0].accountActionBatch || rows[0].accountActionBatch.closed) fail('accountActionSourceUnavailable')
    return rows[0].accountActionBatch as ActionBatch
  }
  return {
    async persistBatch(owner: string, context: ActionContext, calls: Call[]) {
      if (!calls.length || calls.length > 50 || new Set(calls.map(c => c.toolCallId)).size !== calls.length) fail('accountActionBatchInvalid')
      const parsed = calls.filter(c => c.toolName === 'create_calendar_event').map(c => {
        const input = parseActionInput('create_calendar_event', c.input)
        if (!input || !c.toolCallId || c.toolCallId.length > 500) fail('accountActionBatchInvalid')
        return { toolCallId: c.toolCallId, input: input! }
      })
      if (!parsed.length) fail('accountActionBatchInvalid')
      const hash = intentDigest(calls)
      return transaction(async tx => {
        const batch = await source(tx, owner, context)
        const prior = batch.batches.find(b => b.callsDigest === hash)
        if (prior) return prior.slots
        // A new workflow must replay saved slots, never map regenerated calls.
        if (batch.holder !== context.holder) fail('accountActionRecoveryRequired')
        const priorIds = new Set(batch.batches.flatMap(b => b.slots.map(s => s.toolCallId)))
        if (parsed.some(c => priorIds.has(c.toolCallId)) || batch.batches.flatMap(b => b.slots).length + parsed.length > 20) fail('accountActionBatchConflict')
        const slots = parsed.map(c => ({ ...c, actionSlotId: randomUUID() }))
        batch.batches.push({ callsDigest: hash, slots })
        await tx.query('UPDATE coordinator_events SET "accountActionBatch"=$3 WHERE id=$1 AND "userId"=$2', [context.sourceEventId, owner, batch])
        return slots
      })
    },
    async slots(owner: string, context: ActionContext) { return transaction(async tx => (await source(tx, owner, context)).batches.flatMap(b => b.slots)) },
    async bindProposal(owner: string, context: ActionContext, slot: Slot, operationId: string) {
      return transaction(async tx => {
        const batch = await source(tx, owner, context)
        const saved = batch.batches.flatMap(b => b.slots).find(s => s.actionSlotId === slot.actionSlotId)
        if (!saved || intentDigest(saved) !== intentDigest(slot)) fail('accountActionSlotConflict')
        const result = await tx.query(`UPDATE pending_actions SET "sourceEventId"=$3,"actionSlotId"=$4 WHERE id=$1 AND "userId"=$2 AND "intentKey"=$5 AND ("sourceEventId" IS NULL OR ("sourceEventId"=$3 AND "actionSlotId"=$4)) RETURNING id`, [operationId, owner, context.sourceEventId, slot.actionSlotId, intentKeyForSlot(context.sourceEventId, slot.actionSlotId)])
        if (!result.rows.length) fail('accountActionSlotConflict')
        return (await actionRefsForSource(tx, owner, context.sourceEventId)).find(r => r.operationId === operationId)!
      })
    },
    async readWorker(owner: string, runId: string, operationId?: string) {
      return transaction(async tx => {
        const { rows } = await tx.query(`SELECT "accountActionRefs" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND status IN ('preparing','running','waiting_input','finishing') AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">clock_timestamp() FOR SHARE`, [runId, owner])
        if (!rows.length) fail('accountActionRunUnavailable')
        const refs = rows[0].accountActionRefs as AccountActionRef[]
        if (operationId && !refs.some(r => r.operationId === operationId)) fail('accountActionNotBound')
        const results = []
        for (const ref of refs.filter(r => !operationId || r.operationId === operationId)) {
          const current = (await actionRefsForSource(tx, owner, ref.sourceEventId)).find(r => r.operationId === ref.operationId)
          if (!current || intentDigest(current) !== intentDigest(ref)) fail('accountActionBindingChanged')
          const { rows: [row] } = await tx.query(`SELECT p.status AS "proposalStatus",l.status AS "executionStatus",l.receipt FROM pending_actions p LEFT JOIN operation_ledger l ON l."operationId"=p.id AND l."ownerId"=p."userId" AND l."workspaceId"=$3 WHERE p.id=$1 AND p."userId"=$2`, [ref.operationId, owner, `personal:${owner}`])
          results.push({ ...ref, ...row, canExecute: false })
        }
        return results
      })
    },
  }
}

/** Must run inside the proposal INSERT transaction, including after async preflight. */
export async function requireActionSlot(tx: PoolClient, owner: string, authority: ActionContext & { actionSlotId: string }, input: unknown) {
  const lease = await tx.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "leaseHolder"=$2 AND "leaseUntil">clock_timestamp() FOR UPDATE', [owner, authority.holder])
  if (!lease.rows.length) fail('accountActionLeaseLost')
  const { rows: [source] } = await tx.query('SELECT "accountActionBatch" FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind=\'user_message\' FOR UPDATE', [authority.sourceEventId, owner])
  const batch = source?.accountActionBatch as ActionBatch | undefined
  const slot = batch?.batches.flatMap(b => b.slots).find(s => s.actionSlotId === authority.actionSlotId)
  if (!batch || batch.closed || !slot || intentDigest(slot.input) !== intentDigest(input)) fail('accountActionSlotConflict')
}
