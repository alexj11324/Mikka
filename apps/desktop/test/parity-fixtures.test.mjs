import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Execute the real fixture builder and its read/default cleanup helpers. The
// bounded query double records INSERT/DELETE targets; it is not PostgreSQL or a
// substitute for the real native acceptance and account-fingerprint gate.
async function fixtureContract(createParityFixtures, mode) {
  const owner = 'leased-owner'
  const peer = 'leased-peer'
  const options = mode === 'default' ? {} : { includePeerCoordinator: true }
  const tables = new Map()
  const rows = table => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }
  const baseline = [
    { id: 'owner-personal-coordinator', ownerId: owner, workspaceId: 'owner-personal' },
    { id: 'peer-personal-coordinator', ownerId: peer, workspaceId: 'peer-personal' },
  ]
  rows('bots').push(...baseline)
  rows('coordinator_bots').push(...baseline.map(row => ({ ownerId: row.ownerId, workspaceId: row.workspaceId, botId: row.id })))
  const events = []
  const reserved = []
  const cleaned = []
  const lease = { id: 'this-lease', generation: 1 }
  const refusal = new Error('RESOURCE_OWNER_MISMATCH')
  const issuedIdentifier = 'WS12AB34CD-17'
  const invalidIdentity = ['missing-identity', 'empty-identifier', 'wrong-task', 'wrong-workspace', 'wrong-owner'].includes(mode)
  const client = { query: async (sql, args = []) => {
    events.push({ kind: 'sql', sql, args })
    if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now: new Date().toISOString() }] }
    if (sql.startsWith('SELECT "conversationId"')) return { rows: [] }
    if (sql.startsWith('SELECT to_jsonb(t) AS value FROM public."')) return { rows: [] }
    if (sql.startsWith('SELECT id,name,email FROM public."user"')) {
      assert.deepEqual(args, [[owner, peer]])
      return { rows: [{ id: owner, name: 'Owner', email: 'owner@example.invalid' }, { id: peer, name: 'Peer', email: 'peer@example.invalid' }] }
    }
    if (sql === 'SELECT id,"userId","workspaceId","issuedIdentifier" FROM public."issues" WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3') {
      assert.equal(rows('issues').length, 1)
      const task = rows('issues')[0]
      assert.deepEqual(args, [task.id, owner, task.workspaceId], 'identifier read must bind the reserved Task, owner and Workspace')
      if (mode === 'missing-identity') return { rows: [] }
      return { rows: [{ id: mode === 'wrong-task' ? 'foreign-task' : task.id, userId: mode === 'wrong-owner' ? peer : owner,
        workspaceId: mode === 'wrong-workspace' ? 'foreign-workspace' : task.workspaceId, issuedIdentifier: mode === 'empty-identifier' ? '' : task.issuedIdentifier }] }
    }
    const insert = /^INSERT INTO public\."([^"]+)" \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql)
    if (insert) {
      const columns = [...insert[2].matchAll(/"([^"]+)"/g)].map(match => match[1])
      assert.equal(columns.length, args.length)
      const row = Object.fromEntries(columns.map((column, index) => [column, args[index]]))
      if (insert[1] === 'issues') {
        assert.equal(Object.hasOwn(row, 'issuedIdentifier'), false, 'fixtures must not force a legacy display number into the new Task')
        row.issuedIdentifier = issuedIdentifier // Database-generated result, deliberately unlike the Team alias.
      }
      rows(insert[1]).push(row)
      return { rows: [], rowCount: 1 }
    }
    const remove = /^DELETE FROM public\."([^"]+)" WHERE "([^"]+)"::text = ANY\(\$1::text\[\]\)$/.exec(sql)
    if (remove) {
      const before = rows(remove[1])
      const after = before.filter(row => !args[0].includes(String(row[remove[2]])))
      tables.set(remove[1], after)
      return { rows: [], rowCount: before.length - after.length }
    }
    assert.fail('unexpected fixture query')
  } }
  const scope = {
    owner: { userId: owner },
    peer: { userId: peer },
    lease,
    assertActive: async () => {},
    recordResource: async resource => {
      assert.ok([owner, peer].includes(resource.ownerId))
      if (mode === 'refused' && resource.type === 'coordinator_bots' && resource.ownerId === peer) throw refusal
      assert.ok(!reserved.some(value => value.type === resource.type && value.id === resource.id))
      reserved.push(resource)
      events.push({ kind: 'reserved', resource })
    },
    markResourceCleaned: async resource => {
      assert.ok(reserved.some(value => value.type === resource.type && value.id === resource.id))
      cleaned.push(resource)
    },
    pool: {
      environment: {
        version: 1, id: 'parity-coordinator-contract', kind: 'isolated-ci',
        origin: 'http://localhost:3100', basePath: '/mikka', deploymentSha: 'a'.repeat(40),
        database: { host: '127.0.0.1', port: 1, name: 'parity_fixture_e2e', schema: 'public', user: 'fixture' },
        instanceId: '10000000-0000-4000-8000-000000000001',
        capabilities: { provision: true, mail: 'disabled', reset: true },
      },
      current: async (_client, value) => { assert.equal(value, lease) },
      transaction: async work => work(client),
    },
  }
  if (mode === 'refused') {
    await assert.rejects(createParityFixtures(scope, options), error => error === refusal)
    assert.equal(events.filter(event => event.kind === 'sql').length, 0, 'ownership refusal happens before any fixture SQL')
    return
  }
  if (invalidIdentity) {
    await assert.rejects(createParityFixtures(scope, options), { code: 'PARITY_TASK_IDENTITY_INVALID' })
    assert.equal(events.some(event => event.kind === 'sql' && event.sql.startsWith('INSERT INTO public."agent_runs"')), false, 'invalid identity fails before creating a run or exposing a fixture')
    assert.equal(rows('issues').length, 0)
    assert.deepEqual(rows('bots'), baseline)
    assert.equal(cleaned.length, reserved.length)
    return
  }
  const result = await createParityFixtures(scope, options)
  const fixture = result.fixture
  assert.equal(fixture.issueIdentifier, issuedIdentifier, 'exact UI locators use the issued value returned for this Task')
  assert.equal(rows('mikka_teams')[0].identifier, 'APP', 'the historical Team label remains unchanged')
  assert.equal(rows('mikka_team_issues')[0].issueId, fixture.issue)
  assert.equal(rows('mikka_team_issues')[0].workspaceId, fixture.workspace)
  if (mode === 'default') {
    assert.equal(Object.hasOwn(fixture, 'peerCoordinator'), false)
    assert.equal(rows('coordinator_bots').filter(row => row.workspaceId === fixture.workspace).length, 1)
    assert.ok(reserved.every(resource => resource.ownerId === owner))
    const unknown = { id: 'untracked-peer-bot', ownerId: peer, workspaceId: fixture.workspace }
    rows('bots').push(unknown)
    rows('coordinator_bots').push({ ownerId: peer, workspaceId: fixture.workspace, botId: unknown.id })
    await result.cleanup()
    assert.deepEqual(rows('bots'), [...baseline, unknown])
    assert.deepEqual(rows('coordinator_bots').map(row => row.botId), [...baseline.map(row => row.id), unknown.id])
    return
  }
  assert.equal(rows('coordinator_messages').filter(row => row.botId === fixture.peerCoordinator).length, 0, 'the peer does not receive the owner history')
  assert.equal(rows('coordinator_sessions').length, 0, 'the peer chat remains empty')
  assert.match(fixture.peerCoordinator ?? '', /^[a-f0-9-]{36}$/, 'each leased member needs a reserved coordinator')
  assert.notEqual(fixture.peerCoordinator, fixture.coordinator)
  const coordinators = rows('coordinator_bots').filter(row => row.workspaceId === fixture.workspace)
  assert.equal(coordinators.length, 2)
  for (const [userId, botId] of [[owner, fixture.coordinator], [peer, fixture.peerCoordinator]]) {
    assert.equal(coordinators.filter(row => row.ownerId === userId && row.botId === botId).length, 1)
    assert.equal(rows('bots').filter(row => row.id === botId && row.ownerId === userId && row.workspaceId === fixture.workspace).length, 1)
    for (const type of ['bots', 'coordinator_bots', 'coordinator_sessions']) {
      assert.equal(reserved.filter(row => row.type === type && row.id === botId && row.ownerId === userId).length, 1)
    }
  }
  const firstInsert = events.findIndex(event => event.kind === 'sql' && event.sql.startsWith('INSERT'))
  assert.ok(firstInsert > 0)
  assert.equal(events.slice(firstInsert).filter(event => event.kind === 'reserved').length, 0, 'all IDs are reserved before any insertion')
  if (mode === 'cleanup') {
    const unknown = { id: 'untracked-peer-bot', ownerId: peer, workspaceId: fixture.workspace }
    rows('bots').push(unknown)
    rows('coordinator_bots').push({ ownerId: peer, workspaceId: fixture.workspace, botId: unknown.id })
    rows('coordinator_sessions').push({ userId: peer, botId: fixture.peerCoordinator }, { userId: peer, botId: unknown.id })
    await result.cleanup()
    assert.deepEqual(rows('bots'), [...baseline, unknown], 'personal and unreserved peer rows are never swept away')
    assert.deepEqual(rows('coordinator_bots').map(row => row.botId), [...baseline.map(row => row.id), unknown.id])
    assert.deepEqual(rows('coordinator_sessions'), [{ userId: peer, botId: unknown.id }])
    assert.equal(cleaned.length, reserved.length)
    assert.equal(new Set(cleaned.map(row => row.type + ':' + row.id)).size, reserved.length)
  }
}

for (const [mode, title] of [
  ['default', 'ordinary parity retains its owner-only fixture and never adopts or deletes peer rows'],
  ['members', 'both leased members have separately owned, pre-reserved coordinators before UI reads'],
  ['cleanup', 'cleanup removes only reserved coordinator IDs and leaves personal or untracked peer rows dirty'],
  ['refused', 'a refused peer reservation prevents every fixture insertion and cleanup write'],
  ['missing-identity', 'missing issued Task identity prevents the parity fixture from being returned'],
  ['empty-identifier', 'an empty issued identifier never falls back to a guessed Team number'],
  ['wrong-task', 'a different Task identity cannot supply the exact UI locator'],
  ['wrong-workspace', 'a different Workspace identity cannot supply the exact UI locator'],
  ['wrong-owner', 'a different owner identity cannot supply the exact UI locator'],
]) test(title, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-parity-coordinator-'))
  const database = 'postgresql://fixture:' + randomBytes(16).toString('hex') + '@127.0.0.1:1/parity_fixture_e2e'
  const code = [
    "import assert from 'node:assert/strict'",
    'import { createParityFixtures } from ' + JSON.stringify(new URL('./parity-fixtures.mjs', import.meta.url).href),
    'await (' + fixtureContract.toString() + ')(createParityFixtures, ' + JSON.stringify(mode) + ')',
  ].join('\n')
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: directory, encoding: 'utf8', timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: directory,
        E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database,
        BETTER_AUTH_URL: 'http://localhost:3100', MIKKA_TEST_DEPLOYMENT_SHA: 'a'.repeat(40),
      },
    })
    assert.ifError(child.error)
    assert.equal(child.signal, null)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout, '')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
