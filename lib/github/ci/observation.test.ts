import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { observe } from './observation'
import type { Result } from './snapshot'
const complete = (fingerprint: string): Result => ({ kind: 'complete', outcome: 'success', failed: [], fingerprint })

test('waits for stability, deduplicates deliveries and detects a rerun or new head', () => {
  const initial = observe(null, 'a', complete('1'), 100, 50)
  assert.equal(initial.deliver, false)
  assert.equal(observe(initial.state, 'a', complete('1'), 149, 50).deliver, false)
  assert.equal(observe(initial.state, 'a', complete('1'), 150, 50).deliver, true)
  const delivered = { ...initial.state!, deliveredFingerprint: '1' }
  assert.equal(observe(delivered, 'a', complete('1'), 200, 50).deliver, false)
  assert.equal(observe(delivered, 'a', complete('2'), 200, 50).deliver, false)
  assert.equal(observe(delivered, 'b', complete('1'), 200, 50).deliver, false)
  const pending = observe(delivered, 'a', { kind: 'pending' }, 200, 50)
  assert.equal(pending.state?.deliveredFingerprint, '1')
  const completed = observe(pending.state, 'a', complete('1'), 250, 50)
  assert.equal(observe(completed.state, 'a', complete('1'), 300, 50).deliver, false)
})
