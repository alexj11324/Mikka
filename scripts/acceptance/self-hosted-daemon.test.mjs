import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createBrowserRpc } from '../../lib/browser-rpc/handler.ts'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { checkSessionTarget, checkOwnedEnrollment, enrollmentToken, createOwnerRequest } from './self-hosted-daemon.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: 'a'.repeat(40),
  RUNNER_TEMP: '/tmp/runner', GITHUB_WORKSPACE: '/tmp/checkout' }
const session = { origin: 'http://localhost:3000', revision: env.GITHUB_SHA, ownerId: 'fixture-owner',
  workspaceId: 'a0000000-0000-4000-8000-000000000001', cookie: 'session=synthetic-fixture' }

test('daemon acceptance refuses external or mismatched session targets before enrollment', () => {
  assert.doesNotThrow(() => checkSessionTarget(session, env))
  for (const changes of [{ origin: 'https://app.aspectlylabs.com' }, { origin: 'http://localhost:4000' },
    { revision: 'b'.repeat(40) }, { cookie: 'session=value\r\nx-header: injected' }, { workspaceId: 'unknown' }, { ownerId: '' }]) {
    assert.throws(() => checkSessionTarget({ ...session, ...changes }, env), /SESSION_TARGET/)
  }
  for (const changes of [{ GITHUB_ACTIONS: '' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_SHA: 'main' }, { RUNNER_TEMP: '' }]) {
    assert.throws(() => checkSessionTarget(session, { ...env, ...changes }), /CI_TARGET/)
  }
})

test('a fresh local enrollment uses its sole account token, including cleanup after a lost child reply', () => {
  // consumeDeviceEnrollment issues this shape; its local device relationship
  // is exposed by GET /api/devices/enrollment, not by the cloud binding field.
  const token = { id: 'b0000000-0000-4000-8000-000000000002', name: 'SSH', boundDeviceId: null, revokedAt: null }
  assert.equal(enrollmentToken([token]).id, token.id)
  assert.equal(enrollmentToken([{ ...token, revokedAt: '2026-11-07T00:00:00.000Z' }]).id, token.id,
    'cleanup can repeat the owner-scoped revoke if its earlier response was lost')
  for (const tokens of [null, [], [token, { ...token, id: session.workspaceId }], [{ ...token, id: 'unknown' }],
    [{ ...token, boundDeviceId: session.workspaceId }], [{ ...token, boundDeviceId: undefined }], [{ ...token, name: 'Other credential' }]]) {
    assert.throws(() => enrollmentToken(tokens), /TOKEN_IDENTITY/)
  }
})

test('daemon registration must be the sole local device of the verified browser owner', () => {
  const deviceId = 'b0000000-0000-4000-8000-000000000002'
  assert.doesNotThrow(() => checkOwnedEnrollment({ ownerId: session.ownerId, deviceIds: [deviceId] }, session.ownerId, deviceId))
  for (const account of [null, { ownerId: 'other-owner', deviceIds: [deviceId] },
    { ownerId: session.ownerId, deviceIds: [] }, { ownerId: session.ownerId, deviceIds: [session.workspaceId] },
    { ownerId: session.ownerId, deviceIds: [deviceId, session.workspaceId] }]) {
    assert.throws(() => checkOwnedEnrollment(account, session.ownerId, deviceId), /OWNER_DEVICE/)
  }
})

test('daemon owner polling and removal satisfy the real browser RPC transport', async () => {
  const deviceId = 'b0000000-0000-4000-8000-000000000002', invoked = []
  const rpc = createBrowserRpc({
    trustedBaseURL: session.origin,
    authenticate: async headers => headers.get('cookie') === session.cookie ? session : null,
    scope: (identity, work) => { assert.equal(identity, session); return work() },
    actions: {
      'agents.pollDevices': { args: z.tuple([]), invoke: async () => { invoked.push('poll'); return { devices: [] } } },
      'agents.removeDevice': { args: z.tuple([z.string().uuid()]), invoke: async ([id]) => { invoked.push('remove'); return { id } } },
    },
  })
  const owner = createOwnerRequest(session, (url, init) => rpc(new Request(url, init)))
  const poll = await owner('/api/rpc', 'POST', { version: DESKTOP_RPC_VERSION, action: 'agents.pollDevices', args: encode([]) })
  assert.equal(poll.ok, true)
  assert.deepEqual(decode(poll.result), { devices: [] })
  const removed = await owner('/api/rpc', 'POST', { version: DESKTOP_RPC_VERSION, action: 'agents.removeDevice', args: encode([deviceId]) })
  assert.equal(removed.ok, true)
  assert.deepEqual(decode(removed.result), { id: deviceId })
  assert.deepEqual(invoked, ['poll', 'remove'])
})
