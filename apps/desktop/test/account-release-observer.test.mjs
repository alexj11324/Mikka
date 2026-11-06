import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { observeAccountRelease } from './account-release-observer.mjs'
const hashRows = owned => { const h = createHash('sha256'); for (const [t,rows] of [...owned].sort(([a],[b])=>a.localeCompare(b))) h.update(JSON.stringify([t,rows.map(r=>r.text)])); return h.digest('hex') }
const row = value => ({ value, text: JSON.stringify(value) })
function fixture() {
  const lease = { id: 'private-lease', pairId: 'private-pair', generation: 1, environmentId: 'private-environment' }
  const initial = new Map([['mikka_workspaces', [row({ id: 'private-row', userId: 'private-owner', name: 'private-original-name', updatedAt: 'private-time' })]]])
  const empty = new Map()
  let owner = initial, reason = null
  const baseline = hashRows(initial), blank = hashRows(empty)
  const client = { query: async sql => sql.startsWith('SELECT role') ? { rows: [
    { role: 'owner', user_id: 'private-owner', baseline }, { role: 'peer', user_id: 'private-peer', baseline: blank },
  ] } : { rows: [{ blocked_reason: reason }] } }
  const result = { state: 'released', privateId: 'private-result' }
  const pool = {
    current: async (_client, value, options) => { assert.equal(value, lease); assert.equal(options.readOnly, true); assert.equal(options.requireUnexpired, true) },
    transaction: async (callback, options) => { assert.deepEqual(options, { readOnly: true }); return callback(client) },
    ownedRows: async (_client, id) => id === 'private-owner' ? owner : empty,
    release: async () => result,
  }
  return { scope: { lease, owner: { userId: 'private-owner' }, peer: { userId: 'private-peer' }, pool }, result,
    mutate: () => { owner = new Map([['mikka_workspaces', [row({ id: 'private-row', userId: 'private-owner', name: 'private-renamed-name', updatedAt: 'private-time' })]]]); reason = 'ACCOUNT_DIRTY'; result.state = 'quarantined' } }
}
test('observer preserves actual release identity while reporting only changed field names and counts', async () => {
  const f = fixture(), original = f.scope.pool.release
  const observation = await observeAccountRelease(f.scope)
  f.mutate()
  assert.equal(await f.scope.pool.release(f.scope.lease, { outcome: 'clean' }), f.result)
  const report = observation.read()
  assert.equal(report.blockedReason, 'ACCOUNT_DIRTY')
  assert.deepEqual(report.owner.changes, [{ table: 'mikka_workspaces', beforeRows: 1, afterRows: 1, changedFieldValueSets: ['name'], otherChangedFieldCount: 0 }])
  assert.equal(report.owner.matchesSealedBaselineAfter, false)
  assert.equal(report.peer.matchesSealedBaselineAfter, true)
  assert.ok(!JSON.stringify(report).includes('private-'))
  observation.restore()
  assert.equal(f.scope.pool.release, original)
})
test('clean release stays clean; a different lease is never observed', async () => {
  const f = fixture(), observation = await observeAccountRelease(f.scope)
  assert.equal(await f.scope.pool.release({ ...f.scope.lease, id: 'other' }, {}), f.result)
  assert.deepEqual(observation.read(), { observed: false })
  assert.equal(await f.scope.pool.release(f.scope.lease, {}), f.result)
  assert.equal(observation.read().blockedReason, null)
  assert.equal(observation.read().owner.changedTableCount, 0)
})
test('original rejection and observation read failure never alter release behavior', async () => {
  const f = fixture(), error = new Error('private-failure')
  f.scope.pool.release = async () => { throw error }
  const observation = await observeAccountRelease(f.scope)
  await assert.rejects(f.scope.pool.release(f.scope.lease, {}), actual => actual === error)
  assert.deepEqual(observation.read(), { observed: false })
  const g = fixture(), second = await observeAccountRelease(g.scope)
  g.scope.pool.ownedRows = async () => { throw new Error('private-read-failure') }
  assert.equal(await g.scope.pool.release(g.scope.lease, {}), g.result)
  assert.deepEqual(second.read(), { observed: false, failure: 'ACCOUNT_DIAGNOSTIC_READ_FAILED' })
})

test('per-step checkpoints expose only the actual transition and preserve final release', async () => {
  const f = fixture(), observation = await observeAccountRelease(f.scope)
  assert.equal((await observation.checkpoint()).owner.changedTableCount, 0)
  f.mutate()
  const changed = await observation.checkpoint()
  assert.deepEqual(changed.owner.changes[0].changedFieldValueSets, ['name'])
  assert.ok(!JSON.stringify(changed).includes('private-'))
  assert.equal((await observation.checkpoint()).owner.changedTableCount, 0)
  assert.equal(await f.scope.pool.release(f.scope.lease, {}), f.result)
  assert.equal(observation.read().blockedReason, 'ACCOUNT_DIRTY')
})
