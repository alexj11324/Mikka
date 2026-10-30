import test from 'node:test'
import assert from 'node:assert/strict'

import { offlineRetryDelay } from './offline'

test('offline reconnects back off and keep going', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(offlineRetryDelay), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
})
