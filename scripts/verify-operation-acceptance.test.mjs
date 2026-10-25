import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifyOperationReadback } from './operation-readback-contract.mjs'

const manifest = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', operationId: 'fixture-operation', providerObjectId: 'fixture-object' }
const key = createHash('sha256').update(JSON.stringify(['mikka-operation-v1', manifest.ownerId, manifest.workspaceId, manifest.operationId])).digest('hex')
const operation = { ...manifest, status: 'succeeded', receipt: { providerObjectId: manifest.providerObjectId }, idempotencyKey: key }
const remote = { source: 'provider', providerObjectId: manifest.providerObjectId, idempotencyKey: key }

test('accepts exact tenant-bound ledger key and independent remote result', () => {
  assert.doesNotThrow(() => verifyOperationReadback(manifest, operation, remote))
})
test('both missing/empty/wrong keys cannot turn an incomplete readback into a pass', () => {
  for (const idempotencyKey of [undefined, '', 'wrong', 'a'.repeat(64)]) {
    assert.throws(() => verifyOperationReadback(manifest, { ...operation, idempotencyKey }, { ...remote, idempotencyKey }))
  }
})
test('rejects foreign identity, unknown result and mismatched provider object', () => {
  for (const patch of [{ ownerId: 'foreign' }, { workspaceId: 'foreign' }, { operationId: 'foreign' }, { status: 'uncertain' }, { receipt: null }]) {
    assert.throws(() => verifyOperationReadback(manifest, { ...operation, ...patch }, remote))
  }
  for (const patch of [{ source: 'ledger' }, { providerObjectId: 'foreign' }, { idempotencyKey: 'b'.repeat(64) }]) {
    assert.throws(() => verifyOperationReadback(manifest, operation, { ...remote, ...patch }))
  }
})
