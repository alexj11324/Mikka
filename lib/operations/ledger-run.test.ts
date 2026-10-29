import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createOperationLedger, type OperationIntent, type OperationRecord } from './ledger'

function fixture() {
  const run = randomUUID(), other = randomUUID(), id = randomUUID()
  const binding: OperationIntent = { operationId: id, ownerId: 'owner', workspaceId: 'workspace', provider: 'fixture', accountId: 'account', action: 'write', target: 'target', approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64), executionRunId: run }
  const row: OperationRecord = { operationId: id, ownerId: 'owner', workspaceId: 'workspace', binding, idempotencyKey: 'key', status: 'reserved', attemptToken: null, runId: null, receipt: null }
  let writes = 0, calls = 0
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, args: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SELECT pg_advisory')) return { rows: [] }
    if (sql.startsWith('SELECT * FROM operation_ledger')) return { rows: [{ ...row }] }
    if (sql.startsWith('UPDATE operation_ledger SET status=')) { writes++; row.status = 'executing'; row.attemptToken = String(args[1]); row.runId = String(args[2]); return { rows: [{ ...row }] } }
    throw Error(`unexpected query: ${sql}`)
  } }) } as unknown as Parameters<typeof createOperationLedger>[0]
  const ledger = createOperationLedger(pool, async () => { calls++ })
  return { ledger, binding, key: { operationId: id, ownerId: 'owner', workspaceId: 'workspace' }, row, run, other, counts: () => ({ writes, calls }) }
}

test('ledger claims only the bound host run and keeps its attempt token distinct', async () => {
  const f = fixture()
  await assert.rejects(f.ledger.claim(f.key, f.other), /operationRunMismatch/)
  assert.deepEqual(f.counts(), { writes: 0, calls: 0 })
  const claimed = await f.ledger.claim(f.key, f.run)
  assert.equal(claimed.runId, f.run)
  assert.notEqual(claimed.attemptToken, f.run)
  assert.deepEqual(f.counts(), { writes: 1, calls: 1 })
})

test('tampered claimed run fails before invocation or provider execution', async () => {
  const f = fixture()
  const claimed = await f.ledger.claim(f.key, f.run)
  f.row.runId = f.other
  let sent = false
  await assert.rejects(f.ledger.invoke(f.key, claimed.attemptToken!, async () => { sent = true; return { providerObjectId: 'id', evidenceDigest: 'c'.repeat(64) } }), /operationRunMismatch/)
  assert.equal(sent, false)
  assert.equal(f.counts().writes, 1)
})
