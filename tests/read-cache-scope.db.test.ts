import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { measured, readMetrics } from './helpers/read-metrics'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedUser, seedWorkspace } from './support/workspace-admin-db'
import { enterprisePrincipal } from '../lib/enterprise/principal'

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
  const ownerSessionId = randomUUID(), strangerSessionId = randomUUID()
  await pool.query('insert into session (id,"userId",token,"createdAt","updatedAt","expiresAt") values ($1,$2,$3,now(),now(),now()+interval \'1 hour\'),($4,$5,$6,now(),now(),now()+interval \'1 hour\')',
    [ownerSessionId, owner, randomUUID(), strangerSessionId, stranger, randomUUID()])
  const ownerReader = { id: owner, [enterprisePrincipal]: { kind: 'session' as const, sessionId: ownerSessionId } }
  const strangerReader = { id: stranger, [enterprisePrincipal]: { kind: 'session' as const, sessionId: strangerSessionId } }
  const expectAuthority = (value: Awaited<ReturnType<typeof authorizedCacheWorkspace>>, workspaceId: string, role: 'admin' | 'member') => {
    assert.ok(value)
    assert.deepEqual(Object.keys(value).sort(), ['accessExpiresAfterMs', 'accessExpiresAt', 'accessProof', 'role', 'workspaceId'])
    assert.equal(value.workspaceId, workspaceId)
    assert.equal(value.role, role)
    assert.match(value.accessProof!, /^[a-f0-9]{64}$/)
    assert.equal(value.accessExpiresAt, null)
    assert.equal(value.accessExpiresAfterMs, null)
  }
  try {
    const cold = await measured(() => authorizedCacheWorkspace(ownerReader, first.id))
    expectAuthority(cold.value, first.id, 'admin')
    assert.equal(cold.statements, 3, 'membership, canonical Enterprise link and one APP ACL digest; no content or resource identifiers are returned')
    expectAuthority(await withActivitySession(owner, () => authorizedCacheWorkspace(ownerReader), second.id), second.id, 'member')
    assert.equal(await authorizedCacheWorkspace(strangerReader, first.id), null, 'another account never receives hydration authority')
    assert.equal(await authorizedCacheWorkspace(ownerReader, randomUUID()), null, 'an unauthorized explicit workspace never falls back to another cache')
    assert.equal(await authorizedCacheWorkspace(strangerReader), null, 'a read does not create a workspace for a new account')

    await pool.query('UPDATE mikka_workspace_members SET role=\'member\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
    expectAuthority(await authorizedCacheWorkspace(ownerReader, first.id), first.id, 'member')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
    assert.equal(await authorizedCacheWorkspace(ownerReader, first.id), null, 'a suspended membership cannot hydrate its old read models')
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [second.id, owner])
    assert.equal(await authorizedCacheWorkspace(ownerReader, second.id), null)
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    assert.equal(await authorizedCacheWorkspace(ownerReader), null, 'deleted account membership cannot restore data')
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
