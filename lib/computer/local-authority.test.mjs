import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localComputerAuthority } from './local-authority.ts'

// No database, filesystem fixtures, spawned processes or cleanup hooks.
test('local authority returns only the persisted Bot scope and supported current permission', async () => {
  // No policy row (null) and a legacy pre-migration 'ask' both grant allow:
  // the daemon runs each call without a per-step review (2026-10-30).
  for (const permission of ['allow', 'ask', null]) {
    const row = { botId: 'bot', ownerId: 'owner', workspaceId: 'workspace', permission, policyVersion: 3 }
    let parameters
    const pool = { query: async (_sql, values) => { parameters = values; return { rows: [row] } } }
    assert.deepEqual(await localComputerAuthority(pool, 'owner', 'device', 'run'), { ...row, permission: 'allow' })
    assert.deepEqual(parameters.slice(0, 3), ['run', 'owner', 'device'])
  }
})
test('absent ownership, deny, corrupt policy and version never grant local authority', async () => {
  for (const row of [undefined, { permission: 'deny', policyVersion: 1 }, { permission: 'unknown', policyVersion: 1 }, { permission: 'allow', policyVersion: -1 }, { permission: 'allow', policyVersion: 1.5 }, { permission: 'allow', policyVersion: '3' }]) {
    const pool = { query: async () => ({ rows: row ? [row] : [] }) }
    assert.equal(await localComputerAuthority(pool, 'owner', 'device', 'run'), null)
  }
})
test('authority lookup failure propagates without substituting cached allow', async () => {
  const pool = { query: async () => { throw new Error('unavailable') } }
  await assert.rejects(localComputerAuthority(pool, 'owner', 'device', 'run'), /unavailable/)
})
