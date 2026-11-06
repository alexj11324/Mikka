import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withDevicePresence } from './presence-read'
import { readDevicePresenceGrant } from '../device-presence-grant'
import { liveChannelId } from './scope'
import type { PresenceDevice } from './presence'

const now = 1_800_000_000_000
const live = { ownerId: 'owner', workspaceId: '10000000-0000-4000-8000-000000000001', revisions: { thread_list: 4 }, deadline: { at: '2027-02-01T00:00:00Z', afterMs: 5_000 } }
const devices: PresenceDevice[] = [['20000000-0000-4000-8000-000000000001', true, now + 60_000]]
const env = { DEVICE_GATEWAY_URL: 'https://gateway.example', DEVICE_GATEWAY_PUSH_SECRET: 'fixture-presence-secret' }

test('presence attaches to the already-resolved home and observed rows without changing list coverage or inputs', () => {
  const before = structuredClone({ live, devices })
  const result = withDevicePresence(live, devices, env, now)
  assert.ok(result.presence)
  assert.deepEqual(readDevicePresenceGrant(result.presence.token, liveChannelId(live), env.DEVICE_GATEWAY_PUSH_SECRET, now)?.devices, devices)
  assert.strictEqual(result.revisions, live.revisions)
  assert.strictEqual(result.deadline, live.deadline)
  assert.deepEqual({ live, devices }, before)
  assert.strictEqual(withDevicePresence(live, [], env, now), live)
})

test('missing personal home, gateway and oversized proof remain uncovered, including all-offline dependencies', () => {
  assert.equal(withDevicePresence({ ...live, workspaceId: null }, devices, env, now).presence, null)
  assert.equal(withDevicePresence(live, devices, {}, now).presence, null)
  assert.equal(withDevicePresence(live, devices, { ...env, DEVICE_GATEWAY_URL: 'https://secret@gateway.example' }, now).presence, null)
  assert.equal(withDevicePresence(live, Array.from({ length: 17 }, (_, i): PresenceDevice => [`20000000-0000-4000-8000-${i.toString().padStart(12, '0')}`, false, 0]), env, now).presence, null)
  assert.ok(withDevicePresence(live, [[devices[0][0], false, 0]], env, now).presence, 'an offline device still needs its future reconnect notification')
})
