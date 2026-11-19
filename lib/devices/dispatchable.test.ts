import assert from 'node:assert/strict'
import test from 'node:test'
import { listDispatchableDevices, SESSION_OPEN } from './dispatchable'

/**
 * The create dialog offers these machines, and the create path then refuses any device that
 * is not this person's. The list must therefore never widen past the caller's own live,
 * dispatchable local machines, and must never carry anything about them but a name.
 */
test('the roster is the caller\'s own live, dispatchable local devices', async () => {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values })
    return { rows: [{ id: 'd1', name: 'Studio', online: true }] }
  }
  const items = await listDispatchableDevices(query, 'user-1')
  assert.deepEqual(items, [{ id: 'd1', name: 'Studio', online: true }], 'the rows are passed through unchanged')
  assert.equal(calls.length, 1)
  const [{ sql, values }] = calls
  assert.deepEqual(values, ['user-1'], 'the only input is the owner, so the query cannot be widened by a caller')
  assert.match(sql, /WHERE "ownerId"=\$1/)
  assert.match(sql, /"removedAt" IS NULL/)
  assert.match(sql, /\benabled\b/)
  assert.match(sql, /kind='local'/)
  assert.ok(sql.includes(SESSION_OPEN), 'presence is the open gateway session')
  assert.doesNotMatch(sql, /lastSeenAt/, 'no heartbeat window')
  assert.doesNotMatch(sql, /hostname|description|protocolVersion|computerUse|updateFailure/, 'carries nothing but a name and presence')
})

test('a device without an open session is still returned, marked offline', async () => {
  const query = async () => ({ rows: [{ id: 'd2', name: 'Basement', online: false }] })
  assert.deepEqual(await listDispatchableDevices(query, 'user-1'), [{ id: 'd2', name: 'Basement', online: false }])
})
