import assert from 'node:assert/strict'
import test from 'node:test'
import { liveReadKey, liveTelemetry } from './telemetry'
import { sanitizeAnalyticsEvent } from '../analytics-policy'

test('a read has a useful family and distinct digest without the raw key or its data', () => {
  const key = '@"coordinator-chat","01234567-89ab-cdef-0123-456789abcdef",'
  assert.equal(liveReadKey(key).read_key, 'coordinator-chat')
  assert.notEqual(liveReadKey(key).read_key_hash, liveReadKey(key + 'other').read_key_hash)
  assert.equal(liveReadKey('/api/runs/private?token=sk-private').read_key, 'other')
  const event = liveTelemetry({ event: 'read', key: key + 'private prompt', kind: 'bot_chat', id: '01234567-89ab-cdef-0123-456789abcdef' })
  assert.equal(event.properties.live_entity_id, '01234567-89ab-cdef-0123-456789abcdef')
  assert.equal(JSON.stringify(event).includes('private'), false)
  assert.deepEqual(sanitizeAnalyticsEvent(event), event)
})

test('live metadata rejects unsafe IDs and preserves numeric revisions', () => {
  const event = liveTelemetry({ event: 'skipped', reason: 'revision_held', kind: 'run', id: 'sk-secret', rev: 12 })
  assert.deepEqual(event, { event: 'mikka_live_skipped', properties: { live_reason: 'revision_held', live_kind: 'run', live_revision: 12 } })
})

test('a heartbeat round trip reaches analytics as one bounded integer', () => {
  const event = liveTelemetry({ event: 'received', rttMs: 1_500 })
  assert.deepEqual(event, { event: 'mikka_live_received', properties: { live_rtt_ms: 1_500 } })
  // The allowlist is a security boundary: a property it does not name is
  // dropped silently, so this asserts it survives.
  assert.deepEqual(sanitizeAnalyticsEvent(event), event)
})

test('an impossible round trip is not sent at all', () => {
  // A clock that jumps, or a runtime reporting nonsense, must not become data.
  for (const rttMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 600_001]) {
    const properties = liveTelemetry({ event: 'received', rttMs }).properties
    assert.equal('live_rtt_ms' in properties, false, `rttMs ${rttMs} must not be sent`)
  }
  // Nothing to report still sends the event, just without the figure.
  assert.deepEqual(liveTelemetry({ event: 'received' }).properties, {})
})

test('a round trip is reported in whole milliseconds', () => {
  assert.equal(liveTelemetry({ event: 'received', rttMs: 12.6 }).properties.live_rtt_ms, 13)
})
