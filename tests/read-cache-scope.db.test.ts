import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { measured, readMetrics } from './helpers/read-metrics'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedUser, seedWorkspace } from './support/workspace-admin-db'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Cache authorization requires a disposable loopback *_e2e database')
after(async () => {
  if (!enabled) return
  const [{ pool }, { workspacePool }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db')])
  await Promise.all([pool.end(), workspacePool.end()])
})

test('disk hydration authority follows actual membership, role, selected workspace and account deletion', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { authorizedCacheWorkspace } = await import('../lib/swr/cache-scope')
  const owner = await seedUser(pool, 'cache-scope')
  const stranger = await seedUser(pool, 'cache-stranger')
  const first = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const second = await seedWorkspace(pool, owner, [{ userId: owner, role: 'member' }])
  const ids = [first.id, second.id]
  try {
    const cold = await measured(() => authorizedCacheWorkspace(owner, first.id))
    assert.deepEqual(cold.value, { workspaceId: first.id, role: 'admin' })
    assert.equal(cold.statements, 1, 'the server gate adds one bounded membership query, without task/member payloads')
    assert.deepEqual(await withActivitySession(owner, () => authorizedCacheWorkspace(owner), second.id), { workspaceId: second.id, role: 'member' })
    assert.equal(await authorizedCacheWorkspace(stranger, first.id), null, 'another account never receives hydration authority')
    assert.equal(await authorizedCacheWorkspace(owner, randomUUID()), null, 'an unauthorized explicit workspace never falls back to another cache')
    assert.equal(await authorizedCacheWorkspace(stranger), null, 'a read does not create a workspace for a new account')

    await pool.query('UPDATE mikka_workspace_members SET role=\'member\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
    assert.deepEqual(await authorizedCacheWorkspace(owner, first.id), { workspaceId: first.id, role: 'member' }, 'downgrading the viewer changes the disk namespace')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
    assert.equal(await authorizedCacheWorkspace(owner, first.id), null, 'a suspended membership cannot hydrate its old read models')
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [second.id, owner])
    assert.equal(await authorizedCacheWorkspace(owner, second.id), null)
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    assert.equal(await authorizedCacheWorkspace(owner), null, 'deleted account membership cannot restore data')
    t.diagnostic(JSON.stringify({ scenario: 'authenticated_cache_scope_gate', ...readMetrics(cold) }))
  } finally {
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1)', [ids])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1)', [ids])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, stranger]])
  }
})

test('settings cache restores presentation immediately but revalidates the real current preferences', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { getPreferences, updatePreferences } = await import('../app/actions/preferences')
  const { getIssuePrefixState } = await import('../app/actions/issue-prefix')
  const owner = await seedUser(pool, 'cache-settings')
  try {
    const read = () => withActivitySession(owner, async () => ({ preferences: await getPreferences(), prefix: await getIssuePrefixState() }))
    const cold = await measured(read)
    const warm = await measured(read)
    const reload = await measured(read)
    assert.deepEqual(warm.value, cold.value)
    assert.deepEqual(reload.value, cold.value)
    const saved = await withActivitySession(owner, () => updatePreferences({ sendKey: 'modEnter' }))
    assert.equal(saved.error, undefined)
    const changed = await measured(read)
    assert.equal(changed.value.preferences.sendKey, 'modEnter', 'cache presence never suppresses settings refresh')
    await assert.rejects(getPreferences(), { code: 'authRequired' })
    t.diagnostic(JSON.stringify({ scenario: 'settings_notifications_and_prefix_reads', cold: readMetrics(cold), warm: readMetrics(warm), reload: readMetrics(reload), changed: readMetrics(changed), measurement: 'real_read_paths_without_hidden_prefetch_or_browser_assets; settings_without_live_coverage_always_revalidate' }))
  } finally {
    await pool.query('DELETE FROM user_preferences WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
  }
})
