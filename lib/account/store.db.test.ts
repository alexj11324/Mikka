import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Settings › 账户 against real Postgres: devices, shared links, export links,
// avatars and account deletion stay with their person. Database regressions
// run in CI against the ephemeral Postgres 17 (mikka_e2e). Locally, opt in
// with ACCOUNT_DB_TEST=1 and a loopback *_e2e database in all three URLs.
// REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/mikka_e2e'
  const local = process.env.ACCOUNT_DB_TEST === '1' && /^\/mikka_[a-z0-9_]*e2e$/.test(target.pathname)
  if ((ci || local) && ['postgres:', 'postgresql:'].includes(target.protocol)
    && target.hostname === '127.0.0.1' && target.port === '5432'
    && !target.search && !target.hash && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

const PNG = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 1, 2, 3])

async function load() {
  const [{ createRequestDatabaseScope, pool }, sessions, sharedLinks, exportStore, avatar, deletion] = await Promise.all([
    import('../db'), import('./sessions'), import('./shared-links'), import('./export'), import('./avatar'), import('./delete'),
  ])
  return { createRequestDatabaseScope, pool, sessions, sharedLinks, exportStore, avatar, deletion }
}

async function addUser(pool: { query: (text: string, values?: unknown[]) => Promise<unknown> }, id: string) {
  await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, true, now(), now())`, [id, `${id}@example.com`])
}

dbTest('devices, shared links, export links and avatars belong to one person', async t => {
  const { createRequestDatabaseScope, pool, sessions, sharedLinks, exportStore, avatar } = await load()
  const scope = createRequestDatabaseScope(databaseUrl!)
  const alice = `test-account-alice-${randomUUID()}`, bob = `test-account-bob-${randomUUID()}`
  t.after(async () => {
    // user_facts has no foreign key to "user": remove them explicitly so later suites see none.
    await scope.run(() => pool.query('delete from user_facts where "userId" = any($1::text[])', [[alice, bob]]))
    await scope.run(() => pool.query('delete from "user" where id = any($1::text[])', [[alice, bob]]))
    await scope.run(() => pool.query('delete from artifacts where "userId" = any($1::text[])', [[alice, bob]]))
    await scope.close()
  })
  await scope.run(async () => {
    for (const id of [alice, bob]) await addUser(pool, id)
    const session = (id: string, user: string, ua: string | null, updated: string, expires = "now() + interval '1 day'") => pool.query(
      `insert into session (id, token, "userId", "userAgent", "createdAt", "updatedAt", "expiresAt") values ($1, $2, $3, $4, now() - interval '3 days', $5::timestamptz, ${expires})`,
      [id, `token-${id}`, user, ua, updated])
    await session(`${alice}-current`, alice, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', '2026-10-01T00:00:00Z')
    await session(`${alice}-phone`, alice, 'Mikka/12 CFNetwork/1568.100.1 Darwin/24.0.0', '2026-10-20T00:00:00Z')
    await session(`${alice}-old`, alice, null, '2026-10-21T00:00:00Z', "now() - interval '1 minute'")
    await session(`${bob}-laptop`, bob, null, '2026-10-22T00:00:00Z')

    // 登录设备: unexpired only, current first, readable names, no tokens.
    const devices = await sessions.listSignedInDevices(alice, `${alice}-current`)
    assert.deepEqual(devices.map(device => [device.id, device.label, device.current]), [
      [`${alice}-current`, 'Chrome · macOS', true],
      [`${alice}-phone`, 'Mikka · iPhone', false],
    ])
    assert.equal(devices[1].lastActiveAt, '2026-10-20T00:00:00.000Z')
    assert.ok(!JSON.stringify(devices).includes('token-'))
    assert.equal(await sessions.sessionTokenFor(alice, `${alice}-phone`), `token-${alice}-phone`)
    assert.equal(await sessions.sessionTokenFor(alice, `${bob}-laptop`), null)

    // 已共享的链接: live links on the person's own artifacts, one row per artifact.
    const shared = randomUUID(), stopped = randomUUID(), bobs = randomUUID()
    await pool.query(`insert into artifacts (id, "userId", kind, title) values ($1, $4, 'markdown', 'Plan'), ($2, $4, 'markdown', 'Old'), ($3, $5, 'markdown', 'Bob')`, [shared, stopped, bobs, alice, bob])
    const share = (artifact: string, by: string, revoked: boolean, at: string) => pool.query(
      `insert into artifact_shares (id, "artifactId", "tokenHash", "createdBy", "revokedAt", "createdAt") values ($1, $2, $3, $4, ${revoked ? 'now()' : 'null'}, $5)`,
      [randomUUID(), artifact, randomUUID(), by, at])
    await share(shared, alice, false, '2026-10-01T00:00:00Z')
    await share(shared, alice, false, '2026-10-05T00:00:00Z')
    await share(shared, alice, true, '2026-10-06T00:00:00Z')
    await share(stopped, alice, true, '2026-10-07T00:00:00Z')
    await share(bobs, bob, false, '2026-10-08T00:00:00Z')
    assert.deepEqual(await sharedLinks.listSharedArtifacts(alice), [{ artifactId: shared, title: 'Plan', kind: 'markdown', links: 2, sharedAt: '2026-10-05T00:00:00.000Z' }])

    // 导出我的数据: once an hour; the link opens only for its owner until it expires.
    const now = new Date('2026-10-29T12:00:00Z')
    const first = await exportStore.reserveExport(alice, now)
    assert.ok(first.ok)
    assert.match(first.token, /^mkx_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(await exportStore.reserveExport(alice, new Date(now.getTime() + 20 * 60_000)), { ok: false, retryAfterMinutes: 40 })
    assert.ok((await exportStore.reserveExport(bob, now)).ok, 'one person\'s limit is not another\'s')
    const { rows: stored } = await pool.query<{ tokenHash: string }>('select "tokenHash" from account_data_exports where "userId" = $1', [alice])
    assert.notEqual(stored[0].tokenHash, first.token, 'only the hash is stored')
    assert.equal(await exportStore.claimExport(bob, first.token, now), false)
    assert.equal(await exportStore.claimExport(alice, `${first.token}x`, now), false)
    assert.equal(await exportStore.claimExport(alice, first.token, new Date(now.getTime() + 25 * 3_600_000)), false)
    assert.equal(await exportStore.claimExport(alice, first.token, now), true)
    // A failed email gives the reservation back.
    await exportStore.releaseExport(alice, first.id)
    assert.ok((await exportStore.reserveExport(alice, new Date(now.getTime() + 60_000))).ok)

    // The export holds the person's data and none of their secrets.
    await pool.query(`insert into account (id, "accountId", "providerId", "userId", password, "accessToken", "refreshToken", "createdAt", "updatedAt") values ($1, $2, 'credential', $2, 'SECRET-hash', 'SECRET-access', 'SECRET-refresh', now(), now())`, [randomUUID(), alice])
    await pool.query(`insert into linear_connections ("userId", "linearUserId", "organizationId", "organizationName", "accessToken", "refreshToken", "expiresAt") values ($1, 'l1', 'o1', 'Acme', 'SECRET-linear', 'SECRET-linear-refresh', now())`, [alice])
    await pool.query(`insert into credentials (id, user_id, origin, username) values ($1, $2, 'https://example.com', 'alice')`, [randomUUID(), alice])
    await pool.query(`insert into user_facts (id, "userId", kind, subject, "subjectKey", confidence, "firstSeenAt", "lastSeenAt") values ($1, $2, 'interest', '川菜', '川菜', 0.5, now(), now())`, [randomUUID(), alice])
    const data = await exportStore.buildAccountExport(alice, now)
    const text = JSON.stringify(data)
    assert.equal(data.profile?.email, `${alice}@example.com`)
    assert.deepEqual(data.signInMethods.map(row => row.provider), ['credential'])
    assert.equal(data.memory.length, 1)
    assert.equal(data.savedLogins.length, 1)
    assert.equal(data.connections.linear[0].organizationName, 'Acme')
    assert.equal(data.artifacts.length, 2)
    assert.ok(!text.includes('SECRET'), 'no password hash, OAuth or provider token in the export')
    assert.ok(!text.includes('token-'), 'no session token in the export')

    // 头像: content-addressed; replacing one retires the old URL; one person's hash never opens another's.
    const firstPath = await avatar.saveAvatar(alice, 'image/png', PNG(1))
    const firstHash = firstPath.split('/').at(-1)!
    assert.match(firstPath, new RegExp(`^/api/avatars/${alice}/[a-f0-9]{64}$`))
    assert.deepEqual(await avatar.readAvatar(alice, firstHash), { contentType: 'image/png', bytes: PNG(1) })
    assert.equal(await avatar.readAvatar(bob, firstHash), null)
    const secondHash = (await avatar.saveAvatar(alice, 'image/png', PNG(2))).split('/').at(-1)!
    assert.equal(await avatar.readAvatar(alice, firstHash), null)
    assert.ok(await avatar.readAvatar(alice, secondHash))
  })
})

dbTest('deleting an account removes what the person owns, keeps what their team shares, and refuses a sole admin', async t => {
  const { createRequestDatabaseScope, pool, deletion } = await load()
  const scope = createRequestDatabaseScope(databaseUrl!)
  const id = (name: string) => `test-delete-${name}-${randomUUID()}`
  const alice = id('alice'), bob = id('bob'), carol = id('carol'), dave = id('dave')
  const solo = randomUUID(), shared = randomUUID(), carolsTeam = randomUUID(), team = randomUUID()
  const bot = randomUUID(), agent = randomUUID(), device = randomUUID(), run = randomUUID()
  const personalIssue = randomUUID(), teamIssue = randomUUID(), bobIssue = randomUUID()
  const group = randomUUID(), dm = randomUUID(), connection = randomUUID(), artifact = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      for (const table of ['mikka_team_issues', 'mikka_teams']) await pool.query(`delete from ${table} where "workspaceId" = any($1::uuid[])`, [[solo, shared, carolsTeam]])
      await pool.query('delete from mikka_workspace_members where "workspaceId" = any($1::uuid[])', [[solo, shared, carolsTeam]])
      await pool.query('delete from mikka_workspaces where id = any($1::uuid[])', [[solo, shared, carolsTeam]])
      await pool.query('delete from conversations where id = any($1::uuid[])', [[group, dm]])
      await pool.query('delete from issue_documents where "issueId" = any($1::uuid[])', [[personalIssue, teamIssue, bobIssue]])
      await pool.query('delete from issues where id = any($1::uuid[])', [[personalIssue, teamIssue, bobIssue]])
      await pool.query('delete from user_facts where "userId" = any($1::text[])', [[alice, bob, carol, dave]])
      await pool.query('delete from "user" where id = any($1::text[])', [[alice, bob, carol, dave]])
    })
    await scope.close()
  })

  await scope.run(async () => {
    for (const user of [alice, bob, carol, dave]) await addUser(pool, user)
    const workspace = (wid: string, owner: string, name: string) => pool.query(`insert into mikka_workspaces (id, "userId", name) values ($1, $2, $3)`, [wid, owner, name])
    const member = (wid: string, user: string, role: string) => pool.query(`insert into mikka_workspace_members ("workspaceId", "userId", name, email, role) values ($1, $2, $2, $3, $4)`, [wid, user, `${user}@example.com`, role])
    await workspace(solo, alice, 'Alice solo'); await member(solo, alice, 'admin')
    await workspace(shared, alice, 'Shared'); await member(shared, alice, 'admin'); await member(shared, bob, 'admin')
    await workspace(carolsTeam, carol, 'Carol team'); await member(carolsTeam, carol, 'admin'); await member(carolsTeam, dave, 'member')
    await pool.query(`insert into mikka_teams (id, "workspaceId", "userId", name, identifier) values ($1, $2, $3, 'Team', 'TEAM')`, [team, shared, alice])

    // What Alice owns, across the tables the settings promise to clear.
    await pool.query(`insert into session (id, token, "userId", "createdAt", "updatedAt", "expiresAt") values ($1, $1, $2, now(), now(), now() + interval '1 day')`, [`${alice}-s`, alice])
    await pool.query(`insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") values ($1, $2, 'google', $2, now(), now())`, [randomUUID(), alice])
    await pool.query(`insert into bots (id, "workspaceId", "ownerId", name) values ($1, $2, $3, 'Helper')`, [bot, shared, alice])
    await pool.query(`insert into devices (id, "ownerId", name) values ($1, $2, 'Laptop')`, [device, alice])
    await pool.query(`insert into agents (id, "userId", harness, name, "deviceId") values ($1, $2, 'codex', 'Agent', $3)`, [agent, alice, device])
    const issue = (iid: string, owner: string, scope: string) => pool.query(`insert into issues (id, "userId", title, content, status, priority, scope) values ($1, $2, 'T', '{}'::jsonb, 'todo', 'normal', $3)`, [iid, owner, scope])
    await issue(personalIssue, alice, 'personal'); await issue(teamIssue, alice, 'workspace'); await issue(bobIssue, bob, 'personal')
    for (const iid of [personalIssue, teamIssue]) await pool.query(`insert into issue_documents ("issueId", "userId", state) values ($1, $2, 'doc')`, [iid, alice])
    await pool.query(`insert into issue_members ("issueId", "userId", "memberId") values ($1, $2, $3)`, [bobIssue, bob, alice])
    await pool.query(`insert into mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") values ($1, $2, $3, $4)`, [teamIssue, team, shared, alice])
    await pool.query(`insert into agent_runs (id, "userId", "agentId", "botId", "issueId", status) values ($1, $2, $3, $4, $5, 'done')`, [run, alice, agent, bot, teamIssue])
    await pool.query(`insert into run_messages (id, "runId", "userId", text) values ($1, $2, $3, 'hi')`, [randomUUID(), run, alice])
    await pool.query(`insert into coordinator_messages (id, "userId", position, message, "botId") values ($1, $2, 1, '{}'::jsonb, $3)`, [randomUUID(), alice, bot])
    await pool.query(`insert into user_facts (id, "userId", kind, subject, "subjectKey", confidence, "firstSeenAt", "lastSeenAt") values ($1, $2, 'interest', 'x', 'x', 0.5, now(), now())`, [randomUUID(), alice])
    await pool.query(`insert into user_preferences ("userId") values ($1)`, [alice])
    await pool.query(`insert into credentials (id, user_id, origin, username) values ($1, $2, 'https://example.com', 'alice')`, [randomUUID(), alice])
    await pool.query(`insert into composio_accounts ("accountId", "userId", toolkit) values ($1, $2, 'gmail')`, [randomUUID(), alice])
    // A model subscription and its binding: the binding points at the connection without ON DELETE CASCADE.
    await pool.query(`insert into byos_connections (id, "ownerId", "workspaceId", provider) values ($1, $2, $3, 'codex')`, [connection, alice, shared])
    await pool.query(`insert into byos_bindings (id, "ownerId", "workspaceId", "consumerId", "connectionId", "connectionRevision", route, "modelId") values ($1, $2, $3, $4, $5, 1, 'codex_cli', 'gpt')`, [randomUUID(), alice, shared, bot, connection])
    await pool.query(`insert into artifacts (id, "userId", kind, title, "runId") values ($1, $2, 'markdown', 'Plan', $3)`, [artifact, alice, run])
    await pool.query(`insert into artifact_shares (id, "artifactId", "tokenHash", "createdBy") values ($1, $2, $3, $4)`, [randomUUID(), artifact, randomUUID(), alice])
    await pool.query(`insert into account_data_exports (id, "userId", "tokenHash", "expiresAt") values ($1, $2, $3, now() + interval '1 day')`, [randomUUID(), alice, randomUUID()])
    // A group chat in the shared workspace with Bob stays; Alice's DM goes.
    await pool.query(`insert into conversations (id, "workspaceId", kind, title, "createdBy") values ($1, $3, 'group', 'Team chat', $4), ($2, $3, 'agent_dm', 'DM', $4)`, [group, dm, shared, alice])
    await pool.query(`insert into conversation_members ("conversationId", "memberType", "memberId", role) values ($1, 'user', $2, 'owner'), ($1, 'user', $3, 'member'), ($4, 'user', $2, 'owner')`, [group, alice, bob, dm])
    await pool.query(`insert into conversation_messages (id, "conversationId", position, "authorType", "authorId", body) values ($1, $2, 1, 'user', $3, 'hello team')`, [randomUUID(), group, alice])

    // Carol is the only active admin of a workspace Dave belongs to: refused, and nothing changes.
    await pool.query(`insert into user_facts (id, "userId", kind, subject, "subjectKey", confidence, "firstSeenAt", "lastSeenAt") values ($1, $2, 'interest', 'y', 'y', 0.5, now(), now())`, [randomUUID(), carol])
    assert.deepEqual(await deletion.deleteAccount(carol, `${carol}@example.com`), { ok: false, soleAdminOf: ['Carol team'] })
    assert.equal((await pool.query('select 1 from "user" where id = $1', [carol])).rowCount, 1)
    assert.equal((await pool.query('select 1 from user_facts where "userId" = $1', [carol])).rowCount, 1)

    assert.deepEqual(await deletion.deleteAccount(alice, `${alice}@example.com`), { ok: true })

    // Nothing with Alice as its owner is left, in any table (bar the append-only skill ledgers).
    const { rows: columns } = await pool.query<{ table: string; column: string }>(
      `select table_name as "table", column_name as "column" from information_schema.columns
       where table_schema = current_schema() and column_name = any($1::text[]) and table_name not like 'improvement\\_%'`, [deletion.OWNER_COLUMNS])
    const left: string[] = []
    for (const { table, column } of columns) {
      // Team issues of the shared workspace keep their owner column; they stay on purpose.
      if (['issues', 'issue_documents', 'mikka_team_issues', 'mikka_teams', 'mikka_workspaces'].includes(table)) continue
      const { rowCount } = await pool.query(`select 1 from "${table}" where "${column}" = $1 limit 1`, [alice])
      if (rowCount) left.push(`${table}.${column}`)
    }
    assert.deepEqual(left, [])
    assert.equal((await pool.query('select 1 from "user" where id = $1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issues where id = $1', [personalIssue])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issue_documents where "issueId" = $1', [personalIssue])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issue_members where "memberId" = $1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from artifact_shares where "createdBy" = $1', [alice])).rowCount, 0)

    // Her solo workspace went; the shared one, its team issue and group chat stay for Bob.
    assert.equal((await pool.query('select 1 from mikka_workspaces where id = $1', [solo])).rowCount, 0)
    assert.deepEqual((await pool.query<{ userId: string }>('select "userId" from mikka_workspace_members where "workspaceId" = $1', [shared])).rows, [{ userId: bob }])
    assert.equal((await pool.query('select 1 from issues where id = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from issue_documents where "issueId" = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from mikka_team_issues where "issueId" = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from conversations where id = $1', [group])).rowCount, 1)
    assert.equal((await pool.query('select 1 from conversations where id = $1', [dm])).rowCount, 0)
    assert.deepEqual((await pool.query<{ memberId: string }>('select "memberId" from conversation_members where "conversationId" = $1', [group])).rows, [{ memberId: bob }])
    // Bob's own things are untouched.
    assert.equal((await pool.query('select 1 from issues where id = $1', [bobIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from "user" where id = $1', [bob])).rowCount, 1)
  })
})

dbTest('the deletes reach a fixpoint whatever order foreign keys need, and stop on a reference they cannot clear', async t => {
  const { createRequestDatabaseScope, pool, deletion } = await load()
  const scope = createRequestDatabaseScope(databaseUrl!)
  t.after(() => scope.close())
  await scope.run(async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('create temp table fx_parent (id int primary key, owner text)')
      await client.query('create temp table fx_child (id int primary key, parent int references fx_parent(id), owner text)')
      await client.query('create temp table fx_stranger (id int primary key, parent int references fx_parent(id))')
      await client.query(`insert into fx_parent values (1, 'me'), (2, 'me')`)
      await client.query(`insert into fx_child values (1, 1, 'me')`)
      const statements = [
        { table: 'fx_parent', text: 'delete from fx_parent where owner = $1', values: ['me'] },
        { table: 'fx_child', text: 'delete from fx_child where owner = $1', values: ['me'] },
      ]
      // The parent is tried first, waits for its child, and goes on the second pass.
      await deletion.runToFixpoint(client, statements)
      assert.equal((await client.query('select 1 from fx_parent')).rowCount, 0)

      await client.query(`insert into fx_parent values (3, 'me')`)
      await client.query('insert into fx_stranger values (1, 3)')
      await assert.rejects(deletion.runToFixpoint(client, statements), /blocked by references into: fx_parent/)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
