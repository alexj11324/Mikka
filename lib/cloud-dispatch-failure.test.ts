import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudDispatchFailureReason } from './cloud-dispatch-failure'

test('cloud startup failures only name a missing key when absence is confirmed', async () => {
  const query = (configured: boolean) => ({ query: async () => ({ rows: [{ configured }] }) }) as unknown as Parameters<typeof cloudDispatchFailureReason>[0]
  assert.equal(await cloudDispatchFailureReason(query(false), 'owner'), 'cloudNotConfigured')
  assert.equal(await cloudDispatchFailureReason(query(true), 'owner'), 'cloudTemporarilyUnavailable', 'a quota, capacity or template error is not a missing key')
  assert.equal(await cloudDispatchFailureReason({ query: async () => { throw Error('unavailable') } } as unknown as Parameters<typeof cloudDispatchFailureReason>[0], 'owner'), 'cloudTemporarilyUnavailable', 'do not claim absence after an unavailable read')
})
