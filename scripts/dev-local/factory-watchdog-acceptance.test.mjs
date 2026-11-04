import assert from 'node:assert/strict'
import test from 'node:test'
import { assertOnlineQuietSample, assertServerWatchdogStop } from './factory-watchdog-acceptance.mjs'

const now = 1_800_000_000_000
const baseline = { sourceEventId: 'epoch', runStatus: 'running', lastSeenAt: new Date(now - 10_000), leaseExpiresAt: new Date(now + 60_000),
  toolOutputAt: new Date(now - 50_000), checkpointAt: new Date(now - 40_000), progressAt: new Date(now - 40_000) }

test('online watchdog evidence requires a live heartbeat/lease and no new checkpoint or tool progress', () => {
  assertOnlineQuietSample(baseline, baseline, 'epoch', now)
  for (const change of [
    { sourceEventId: 'old-epoch' }, { runStatus: 'waiting_input' }, { runStatus: 'paused' }, { runStatus: 'failed' },
    { lastSeenAt: new Date(now - 61_000) }, { leaseExpiresAt: new Date(now - 1) },
    { toolOutputAt: new Date(now) }, { checkpointAt: new Date(now) }, { progressAt: new Date(now) },
  ]) assert.throws(() => assertOnlineQuietSample({ ...baseline, ...change }, baseline, 'epoch', now))
})

test('only the current-epoch server stall receipt after the full 45-minute window counts', () => {
  const at = new Date(baseline.progressAt.getTime() + 45 * 60_000)
  const stopped = { stopRequestedAt: at, watchdog: { reasonCode: 'task_stalled', requestEpoch: 'epoch', stoppedAt: at.toISOString() } }
  assert.equal(assertServerWatchdogStop(stopped, baseline, 'epoch'), 45 * 60_000)
  for (const change of [{ reasonCode: 'external_effect_uncertain' }, { requestEpoch: 'old-epoch' }, { stoppedAt: new Date(at.getTime() - 1).toISOString() }]) {
    assert.throws(() => assertServerWatchdogStop({ ...stopped, watchdog: { ...stopped.watchdog, ...change } }, baseline, 'epoch'))
  }
  assert.throws(() => assertServerWatchdogStop({ ...stopped, stopRequestedAt: null }, baseline, 'epoch'))
})
