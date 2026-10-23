import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { checkedLocalReview } from './local-review'
import { computerSyncBody } from '@mikka/protocol/computer'
function snapshot() {
  const value = { id: randomUUID(), runId: randomUUID(), target: 'f'.repeat(64), call: { name: 'click' as const, arguments: { x: 3, y: 4 } }, expiresAt: Date.now() + 100000 }
  return { ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}
test('web snapshot is exact, bounded, normalized and hash-bound to the daemon review', () => {
  const row = snapshot()
  assert.deepEqual(checkedLocalReview(row), row)
  for (const key of ['id', 'runId', 'target', 'expiresAt'] as const) {
    assert.throws(() => checkedLocalReview({ ...row, [key]: key === 'expiresAt' ? row.expiresAt + 10 : key === 'target' ? 'a'.repeat(64) : randomUUID() }))
  }
  assert.throws(() => checkedLocalReview({ ...row, call: { name: 'click', arguments: { x: 3, y: 5 } } }))
  assert.throws(() => checkedLocalReview({ ...row, call: { name: 'shell', arguments: {} } }))
  assert.throws(() => checkedLocalReview({ ...row, call: { name: 'click', arguments: { x: 3, y: 4, file: '/tmp/private' } } }))
  assert.throws(() => checkedLocalReview(row, row.expiresAt + 1))
  assert.throws(() => checkedLocalReview(row, row.expiresAt - 300001))
  assert.equal(computerSyncBody.safeParse({ requests: Array.from({ length: 21 }, snapshot) }).success, false)
})
