import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentPlacement, type PlacementDevice } from './agent-placement'

const laptop: PlacementDevice = {
  id: 'laptop', online: true, enabled: true, lastSeenAt: new Date('2026-10-21T10:00:00Z'),
  harnesses: [{ harness: 'claude_code', installed: true }, { harness: 'codex', installed: false }],
}
const server: PlacementDevice = {
  id: 'server', online: true, enabled: true, lastSeenAt: new Date('2026-10-21T11:00:00Z'),
  harnesses: [{ harness: 'claude_code', installed: false }, { harness: 'codex', installed: true }],
}
const offline: PlacementDevice = {
  id: 'offline', online: false, enabled: true, lastSeenAt: new Date('2026-10-21T12:00:00Z'),
  harnesses: [{ harness: 'claude_code', installed: true }, { harness: 'codex', installed: true }],
}
const auto = { deviceId: null, harness: null, model: null }

test('auto everything picks the most recently seen online device and its preferred harness', () => {
  assert.deepEqual(resolveAgentPlacement(auto, [laptop, server, offline]), { ok: true, deviceId: 'server', harness: 'codex', model: null })
})

test('auto device honours a pinned harness', () => {
  assert.deepEqual(resolveAgentPlacement({ ...auto, harness: 'claude_code', model: 'opus' }, [laptop, server]), { ok: true, deviceId: 'laptop', harness: 'claude_code', model: 'opus' })
})

test('an online device wins over a more recently seen offline one', () => {
  const result = resolveAgentPlacement({ ...auto, harness: 'claude_code' }, [offline, laptop])
  assert.equal(result.ok && result.deviceId, 'laptop')
})

test('a disabled device is never picked', () => {
  assert.deepEqual(resolveAgentPlacement(auto, [{ ...laptop, enabled: false }]), { ok: false, reason: 'noDevice' })
  assert.deepEqual(resolveAgentPlacement({ ...auto, deviceId: 'laptop' }, [{ ...laptop, enabled: false }]), { ok: false, reason: 'deviceUnavailable' })
})

test('a pinned device without the pinned harness fails instead of switching', () => {
  assert.deepEqual(resolveAgentPlacement({ ...auto, deviceId: 'laptop', harness: 'codex' }, [laptop, server]), { ok: false, reason: 'harnessMissing' })
})

test('the repository device decides an auto device and must match a pinned one', () => {
  assert.deepEqual(resolveAgentPlacement(auto, [laptop, server], 'laptop'), { ok: true, deviceId: 'laptop', harness: 'claude_code', model: null })
  assert.deepEqual(resolveAgentPlacement({ ...auto, deviceId: 'server' }, [laptop, server], 'laptop'), { ok: false, reason: 'deviceUnavailable' })
})

test('no device with any harness reports what is missing', () => {
  assert.deepEqual(resolveAgentPlacement(auto, []), { ok: false, reason: 'noDevice' })
  assert.deepEqual(resolveAgentPlacement({ ...auto, harness: 'codex' }, [laptop]), { ok: false, reason: 'harnessMissing' })
})
