import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { observe } from './observation'
import type { Result } from './snapshot'
const complete = (fingerprint: string): Result => ({ kind: 'complete', outcome: 'success', failed: [], fingerprint })

test('a complete result is stable only after an unchanged quiet window; pending or a change restarts it', () => {
  const initial = observe(null, 'a', complete('1'), 100, 50)
  assert.equal(initial.stable, false)
  assert.equal(observe(initial.state, 'a', complete('1'), 149, 50).stable, false)
  assert.equal(observe(initial.state, 'a', complete('1'), 150, 50).stable, true)
  const changed = observe(initial.state, 'a', complete('2'), 200, 50)
  assert.equal(changed.stable, false)
  assert.equal(changed.state?.firstSeenAt, 200)
  assert.equal(observe(initial.state, 'b', complete('1'), 200, 50).stable, false)
  const pending = observe(initial.state, 'a', { kind: 'pending' }, 200, 50)
  assert.deepEqual(pending, { state: { head: 'a', fingerprint: null, firstSeenAt: 200 }, stable: false })
  assert.equal(observe(pending.state, 'a', complete('1'), 250, 50).stable, false)
})
