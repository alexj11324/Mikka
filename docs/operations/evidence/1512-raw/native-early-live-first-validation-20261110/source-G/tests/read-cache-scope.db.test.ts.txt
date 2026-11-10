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
  try {
    const cold = await measured(() => authorizedCacheWorkspace(ownerReader, first.id))
    assert.deepEqual(cold.value, { workspaceId: first.id, role: 'admin' })
    assert.equal(cold.statements, 2, 'Enterprise adds one canonical Organization-link check to the bounded membership read; neither query loads task/member payloads')
    assert.deepEqual(await withActivitySession(owner, () => authorizedCacheWorkspace(ownerReader), second.id), { workspaceId: second.id, role: 'member' })
    assert.equal(await authorizedCacheWorkspace(strangerReader, first.id), null, 'another account never receives hydration authority')
    assert.equal(await authorizedCacheWorkspace(ownerReader, randomUUID()), null, 'an unauthorized explicit workspace never falls back to another cache')
    assert.equal(await authorizedCacheWorkspace(strangerReader), null, 'a read does not create a workspace for a new account')

    await pool.query('UPDATE mikka_workspace_members SET role=\'member\' WHERE "workspaceId"=$1 AND "userId"=$2', [first.id, owner])
    assert.deepEqual(await authorizedCacheWorkspace(ownerReader, first.id), { workspaceId: first.id, role: 'member' }, 'downgrading the viewer changes the disk namespace')
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

test('bootstrap derives only a unique owner Live route from the current cache membership read', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { authorizedBootstrapScopes, authorizedCacheWorkspace, liveHomeWorkspaceHint } = await import('../lib/swr/cache-scope')
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const owner = `bootstrap-route-${randomUUID()}`, peer = `bootstrap-route-peer-${randomUUID()}`
  const sessionId = randomUUID(), peerSessionId = randomUUID(), organizationId = randomUUID()
  const selected = randomUUID(), ownedTeam = randomUUID(), home = randomUUID(), foreignHome = randomUUID(), duplicateHome = randomUUID()
  const ids = [selected, ownedTeam, home, foreignHome, duplicateHome]
  const reader = { id: owner, [enterprisePrincipal]: { kind: 'session' as const, sessionId } }
  const peerReader = { id: peer, [enterprisePrincipal]: { kind: 'session' as const, sessionId: peerSessionId } }
  const unavailable = { cacheWorkspace: null, liveHomeWorkspaceId: null }
  const expected = (workspaceId: string, role: 'admin' | 'member', liveHomeWorkspaceId: string | null = home) => ({
    cacheWorkspace: { workspaceId, role }, liveHomeWorkspaceId,
  })
  const selectedRequest = <T>(value: string, work: () => T) => runRequestScope(createRequestScope(new Request('https://bootstrap-fixture.example.invalid', {
    headers: { 'x-mikka-workspace-id': value },
  })), work)
  t.after(async () => {
    await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organizationId])
    await pool.query('DELETE FROM mikka_organization_workspaces WHERE "organizationId"=$1', [organizationId])
    await pool.query('DELETE FROM mikka_organizations WHERE id=$1', [organizationId])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  })
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now()),($3,$3,$4,true,now(),now())',
    [owner, `${owner}@example.invalid`, peer, `${peer}@example.invalid`])
  await pool.query('INSERT INTO session (id,"userId",token,"createdAt","updatedAt","expiresAt") VALUES ($1,$2,$3,now(),now(),now()+interval \'1 hour\'),($4,$5,$6,now(),now(),now()+interval \'1 hour\')',
    [sessionId, owner, randomUUID(), peerSessionId, peer, randomUUID()])
  await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,kind,"createdAt") VALUES
    ($1,$5,'Selected team','team','2020-01-01'),($2,$6,'Owned team','team','2020-01-02'),
    ($3,$6,'Owner home','personal','2020-01-03'),($4,$5,'Foreign home','personal','2020-01-04')`,
  [selected, ownedTeam, home, foreignHome, peer, owner])
  await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES
    ($1,$5,$5,$7,'member','active'),($2,$5,$5,$7,'admin','active'),
    ($3,$5,$5,$7,'admin','suspended'),($4,$5,$5,$7,'admin','active'),($4,$6,$6,$8,'admin','active')`,
  [selected, ownedTeam, home, foreignHome, owner, peer, `${owner}@example.invalid`, `${peer}@example.invalid`])

  await t.test('real PG: owned teams, foreign personal rows and suspended home membership produce no owner route', async () => {
    const cache = await measured(() => authorizedCacheWorkspace(reader, selected))
    const bootstrap = await measured(() => authorizedBootstrapScopes(reader, selected))
    assert.deepEqual(cache.value, { workspaceId: selected, role: 'member' })
    assert.deepEqual(bootstrap.value, expected(selected, 'member', null))
    assert.equal(cache.statements, 2, 'the existing membership and selected Organization-link reads')
    assert.equal(bootstrap.statements, cache.statements, 'the home hint adds no database statement')
    assert.equal(await authorizedCacheWorkspace(reader, foreignHome), null, 'an active foreign-personal membership cannot authorize a cache')
    t.diagnostic(JSON.stringify({ scenario: 'bootstrap_live_hint_no_extra_query', cache: readMetrics(cache), bootstrap: readMetrics(bootstrap) }))
  })

  await t.test('synthetic projection: zero or multiple owned personal rows fail closed without changing the PG uniqueness constraint', () => {
    const own = { workspaceId: home, ownerId: owner, kind: 'personal' as const }
    const team = { workspaceId: ownedTeam, ownerId: owner, kind: 'team' as const }
    const foreign = { workspaceId: foreignHome, ownerId: peer, kind: 'personal' as const }
    assert.equal(liveHomeWorkspaceHint(owner, []), null)
    assert.equal(liveHomeWorkspaceHint(owner, [team, foreign]), null)
    assert.equal(liveHomeWorkspaceHint(owner, [team, own, foreign]), home)
    assert.equal(liveHomeWorkspaceHint(owner, [own, { ...own, workspaceId: randomUUID() }]), null)
    assert.equal(liveHomeWorkspaceHint(owner, [own, own]), null, 'duplicate projected rows do not select an arbitrary home')
  })

  await t.test('real PG: the personal-owner unique index remains enforced', async () => {
    await assert.rejects(pool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Duplicate home\',\'personal\')',
      [duplicateHome, owner]), { code: '23505', constraint: 'mikka_workspaces_personal_owner_unique' })
  })

  await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
  await t.test('real PG: a restored unique home remains separate from the selected team and cache response shape', async () => {
    const bootstrap = await measured(() => authorizedBootstrapScopes(reader, selected))
    const cache = await measured(() => authorizedCacheWorkspace(reader, selected))
    assert.deepEqual(bootstrap.value, expected(selected, 'member'))
    assert.deepEqual(cache.value, { workspaceId: selected, role: 'member' }, 'kind and ownerId never enter the existing cache contract')
    assert.equal(bootstrap.statements, cache.statements)
    assert.equal(bootstrap.statements, 2)
    assert.deepEqual(await authorizedBootstrapScopes(reader, home), expected(home, 'admin'))
    assert.deepEqual(await authorizedBootstrapScopes(reader, ownedTeam), expected(ownedTeam, 'admin'))
  })

  await t.test('real PG: cookie fallback and an explicit valid selection keep their original precedence', async () => {
    assert.deepEqual(await withActivitySession(owner, () => authorizedBootstrapScopes(reader), ownedTeam), expected(ownedTeam, 'admin'))
    assert.deepEqual(await withActivitySession(owner, () => authorizedBootstrapScopes(reader), randomUUID()), expected(selected, 'member'))
    assert.deepEqual(await withActivitySession(owner, () => selectedRequest(selected, () => authorizedBootstrapScopes(reader)), home), expected(selected, 'member'))
  })

  await t.test('real PG: malformed and conflicting request pins still reject before any SELECT', async () => {
    for (const value of ['', 'not-a-workspace']) {
      const result = await measured(() => selectedRequest(value, () => authorizedBootstrapScopes(reader, selected)))
      assert.deepEqual(result.value, unavailable)
      assert.equal(result.statements, 0)
    }
    const conflict = await measured(() => selectedRequest(selected, () => authorizedBootstrapScopes(reader, ownedTeam)))
    assert.deepEqual(conflict.value, unavailable)
    assert.equal(conflict.statements, 0)
  })

  await t.test('real PG: unauthorized explicit targets, pinned targets and other readers cannot borrow the home hint', async () => {
    const explicit = await measured(() => authorizedBootstrapScopes(reader, foreignHome))
    const pin = await measured(() => selectedRequest(randomUUID(), () => authorizedBootstrapScopes(reader)))
    const otherReader = await measured(() => authorizedBootstrapScopes(peerReader, home))
    for (const result of [explicit, pin, otherReader]) {
      assert.deepEqual(result.value, unavailable)
      assert.equal(result.statements, 1, 'membership rejection does not advance to the selected Organization gate')
    }
    assert.deepEqual(await authorizedBootstrapScopes(reader, randomUUID()), unavailable, 'an unknown explicit target never falls back')
  })

  await t.test('real PG: a later call observes home membership suspension and restoration', async () => {
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
    try {
      assert.deepEqual(await authorizedBootstrapScopes(reader, selected), expected(selected, 'member', null))
    } finally {
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
    }
    assert.deepEqual(await authorizedBootstrapScopes(reader, selected), expected(selected, 'member'))
  })

  await t.test('real PG: a later call observes kind changes without creating a replacement home', async () => {
    await pool.query('UPDATE mikka_workspaces SET kind=\'team\' WHERE id=$1', [home])
    try {
      assert.deepEqual(await authorizedBootstrapScopes(reader, selected), expected(selected, 'member', null))
      const count = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM mikka_workspaces WHERE "userId"=$1', [owner])
      assert.equal(count.rows[0].count, 2, 'routing lookup does not create a workspace')
    } finally {
      await pool.query('UPDATE mikka_workspaces SET kind=\'personal\' WHERE id=$1', [home])
    }
  })

  await t.test('real PG: deleted home membership cannot supply a route while the selected team stays authorized', async () => {
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
    try {
      assert.deepEqual(await authorizedBootstrapScopes(reader, selected), expected(selected, 'member', null))
    } finally {
      await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')',
        [home, owner, `${owner}@example.invalid`])
    }
  })

  await t.test('real PG: revoking the selected membership removes both fields even when the owner home is active', async () => {
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner])
    try {
      assert.deepEqual(await authorizedBootstrapScopes(reader, selected), unavailable)
    } finally {
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner])
    }
  })

  await t.test('real PG: every call rechecks the selected Organization policy before returning either field', async () => {
    await pool.query('INSERT INTO mikka_organizations (id,name,"createdBy") VALUES ($1,\'Bootstrap routing fixture\',$2)', [organizationId, owner])
    await pool.query('INSERT INTO enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") VALUES ($1,false,false)', [organizationId])
    await pool.query('INSERT INTO mikka_organization_workspaces ("workspaceId","organizationId") VALUES ($1,$2)', [selected, organizationId])
    const allowed = await measured(() => authorizedBootstrapScopes(reader, selected))
    assert.deepEqual(allowed.value, expected(selected, 'member'))
    assert.equal(allowed.statements, 3, 'membership, selected canonical Organization link and current Organization policy')
    await pool.query('UPDATE enterprise_org_policy SET "archivedAt"=now() WHERE "organizationId"=$1', [organizationId])
    const denied = await measured(() => authorizedBootstrapScopes(reader, selected))
    assert.deepEqual(denied.value, unavailable)
    assert.equal(denied.statements, allowed.statements)
    assert.equal(await authorizedCacheWorkspace(reader, selected), null)
    await pool.query('UPDATE enterprise_org_policy SET "archivedAt"=null WHERE "organizationId"=$1', [organizationId])
    const restored = await measured(() => authorizedBootstrapScopes(reader, selected))
    assert.deepEqual(restored.value, expected(selected, 'member'))
    assert.equal(restored.statements, allowed.statements)
  })
})
