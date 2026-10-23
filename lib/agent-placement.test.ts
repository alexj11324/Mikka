import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentPlacement, runtimeOptionsError, type PlacementDevice } from './agent-placement'

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

const reported = {
  models: [{ value: 'opus', efforts: ['low', 'medium', 'high'] }, { value: 'haiku', efforts: [] }],
  permissionModes: ['default', 'acceptEdits', 'plan'],
}
const none = { model: null, effort: null, permissionMode: null }

test('runtime options: null mode and effort always pass, even with nothing reported', () => {
  assert.equal(runtimeOptionsError(null, none), null)
  assert.equal(runtimeOptionsError({}, { ...none, model: 'opus' }), null)
})

test('runtime options: a permission mode must be on the reported list', () => {
  assert.equal(runtimeOptionsError(reported, { ...none, permissionMode: 'plan' }), null)
  assert.equal(runtimeOptionsError(reported, { ...none, permissionMode: 'bypassPermissions' }), 'agentPermissionModeInvalid')
  assert.equal(runtimeOptionsError({ models: reported.models }, { ...none, permissionMode: 'plan' }), 'agentPermissionModeInvalid')
  assert.equal(runtimeOptionsError(null, { ...none, permissionMode: 'plan' }), 'agentPermissionModeInvalid')
})

test('runtime options: an effort must be one of the pinned model\'s levels', () => {
  assert.equal(runtimeOptionsError(reported, { ...none, model: 'opus', effort: 'high' }), null)
  assert.equal(runtimeOptionsError(reported, { ...none, model: 'opus', effort: 'max' }), 'agentEffortInvalid')
  assert.equal(runtimeOptionsError(reported, { ...none, model: 'haiku', effort: 'low' }), 'agentEffortInvalid')
  assert.equal(runtimeOptionsError(reported, { ...none, model: 'unknown', effort: 'low' }), 'agentEffortInvalid')
  assert.equal(runtimeOptionsError(reported, { ...none, effort: 'low' }), 'agentEffortInvalid')
  assert.equal(runtimeOptionsError(null, { ...none, model: 'opus', effort: 'low' }), 'agentEffortInvalid')
})
