import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

// Settings › 账户 against real Postgres: devices, shared links, export links,
// avatars and account deletion stay with their person. Runs when one loopback
// *_e2e database is in all three URLs. REQUIRE_DB=1 makes a missing database fail.
const target = process.env.E2E_DATABASE_URL
const databaseUrl = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target ? target : undefined
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback *_e2e database')
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
  const personalFile = `task-files/${personalIssue}/${randomUUID()}`, teamFile = `task-files/${teamIssue}/${randomUUID()}`
  const group = randomUUID(), dm = randomUUID(), connection = randomUUID(), artifact = randomUUID()
  const soloBot = randomUUID(), soloRun = randomUUID(), coordinator = randomUUID(), coordinatorRun = randomUUID(), liveRun = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      // The kept bot and its threads have no owner left to cascade from.
      await pool.query('delete from artifacts where id = $1', [artifact])
      await pool.query('delete from agent_runs where "botId" = $1', [bot])
      await pool.query('delete from bots where id = $1', [bot])
      await pool.query('delete from agents where id = $1', [agent])
      for (const table of ['mikka_team_issues', 'mikka_teams']) await pool.query(`delete from ${table} where "workspaceId" = any($1::uuid[])`, [[solo, shared, carolsTeam]])
      await pool.query('delete from mikka_workspace_members where "workspaceId" = any($1::uuid[])', [[solo, shared, carolsTeam]])
      await pool.query('delete from mikka_workspaces where id = any($1::uuid[])', [[solo, shared, carolsTeam]])
      await pool.query('delete from conversations where id = any($1::uuid[])', [[group, dm]])
      await pool.query('delete from issue_documents where "issueId" = any($1::uuid[])', [[personalIssue, teamIssue, bobIssue]])
      await pool.query('delete from issues where id = any($1::uuid[])', [[personalIssue, teamIssue, bobIssue]])
      await pool.query('delete from chat_attachment_retirements where "storageKey" = any($1::text[])', [[personalFile, teamFile]])
      await pool.query('delete from user_facts where "userId" = any($1::text[])', [[alice, bob, carol, dave]])
      for (const table of ['workspace_settings', 'workspace_secrets', 'workspace_e2b_keys', 'hosted_allowances']) await pool.query(`delete from ${table} where "workspaceId" = any($1::uuid[])`, [[solo, shared]])
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
    // Her bot in her own workspace and her Coordinator in the shared one are hers alone.
    await pool.query(`insert into bots (id, "workspaceId", "ownerId", name) values ($1, $2, $3, 'Mine'), ($4, $5, $3, 'Coordinator')`, [soloBot, solo, alice, coordinator, shared])
    await pool.query(`insert into coordinator_bots ("ownerId", "workspaceId", "botId") values ($1, $2, $3)`, [alice, shared, coordinator])
    // Owner-bound rows on the kept bot, through the composite (id, workspaceId, ownerId) foreign keys: they go before its owner is cleared.
    await pool.query(`insert into cloud_machines ("workspaceId", "ownerId", "operationId") values ($1, $2, $3)`, [shared, alice, randomUUID()])
    await pool.query(`insert into bot_desktops ("botId", "workspaceId", "ownerId", display) values ($1, $2, $3, 1)`, [bot, shared, alice])
    await pool.query(`insert into bot_subagents (id, "workspaceId", "ownerId", "botId", task, status) values ($1, $2, $3, $4, 'look', 'done')`, [randomUUID(), shared, alice, bot])
    await pool.query(`insert into devices (id, "ownerId", name) values ($1, $2, 'Laptop')`, [device, alice])
    await pool.query(`insert into agents (id, "userId", harness, name, "deviceId") values ($1, $2, 'codex', 'Agent', $3)`, [agent, alice, device])
    const bobHome = await seedFixtureWorkspace(pool, bob)
    const issue = (iid: string, owner: string, scope: string, workspaceId: string) => pool.query(`insert into issues (id, "userId", "workspaceId", title, content, status, priority, scope) values ($1, $2, $4, 'T', '{}'::jsonb, 'todo', 'normal', $3)`, [iid, owner, scope, workspaceId])
    await issue(personalIssue, alice, 'personal', solo); await issue(teamIssue, alice, 'workspace', shared); await issue(bobIssue, bob, 'personal', bobHome)
    for (const [taskId, key] of [[personalIssue, personalFile], [teamIssue, teamFile]]) {
      await pool.query(`insert into task_attachments ("taskId", id, name, size, sha256, "storageKey", "userId")
        values ($1,$2,'sample.bin',1,repeat('0',64),$3,$4)`, [taskId, randomUUID(), key, alice])
    }
    for (const iid of [personalIssue, teamIssue]) await pool.query(`insert into issue_documents ("issueId", "userId", state) values ($1, $2, 'doc')`, [iid, alice])
    await pool.query(`insert into issue_members ("issueId", "userId", "memberId") values ($1, $2, $3)`, [bobIssue, bob, alice])
    await pool.query(`insert into mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") values ($1, $2, $3, $4)`, [teamIssue, team, shared, alice])
    await pool.query(`insert into agent_runs (id, "userId", "agentId", "botId", "issueId", status) values ($1, $2, $3, $4, $5, 'done')`, [run, alice, agent, bot, teamIssue])
    await pool.query(`insert into agent_runs (id, "userId", "agentId", "botId", status) values ($1, $2, $3, $4, 'running'), ($5, $2, $3, $6, 'succeeded'), ($7, $2, $3, $8, 'succeeded')`,
      [liveRun, alice, agent, bot, soloRun, soloBot, coordinatorRun, coordinator])
    await pool.query(`insert into run_messages (id, "runId", "userId", text) values ($1, $2, $3, 'hi')`, [randomUUID(), run, alice])
    await pool.query(`insert into run_messages (id, "runId", "userId", text) values ($1, $2, $3, 'mine')`, [randomUUID(), soloRun, alice])
    await pool.query(`insert into run_tokens (id, "runId", "userId", "tokenHash", "expiresAt") values ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), liveRun, alice, randomUUID()])
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

    // Rows keyed by a workspace rather than by Alice (gap M4): her solo workspace's go with it, whoever wrote them; the shared one keeps its own.
    const formerBot = randomUUID()
    await pool.query(`insert into bots (id, "workspaceId", "ownerId", name) values ($1, $2, $3, 'Left behind')`, [formerBot, solo, dave])
    for (const wid of [solo, shared]) {
      await pool.query(`insert into workspace_settings ("workspaceId") values ($1)`, [wid])
      await pool.query(`insert into workspace_secrets (id, "workspaceId", name, kind, "scopeType", "scopeRef", ciphertext, iv, "keyVersion", "createdBy", "updatedBy") values ($1, $2, 'TOKEN', 'secret', 'workspace', '', 'c', 'i', 1, $3, $3)`, [randomUUID(), wid, alice])
      await pool.query(`insert into workspace_e2b_keys ("workspaceId", ciphertext, iv, "keyVersion", last4, "createdBy", "updatedBy") values ($1, 'c', 'i', 1, 'abcd', $2, $2)`, [wid, alice])
      await pool.query(`insert into hosted_allowances ("workspaceId", remaining) values ($1, 5)`, [wid])
    }

    // Carol is the only active admin of a workspace Dave belongs to: refused, and nothing changes.
    await pool.query(`insert into user_facts (id, "userId", kind, subject, "subjectKey", confidence, "firstSeenAt", "lastSeenAt") values ($1, $2, 'interest', 'y', 'y', 0.5, now(), now())`, [randomUUID(), carol])
    assert.deepEqual(await deletion.deleteAccount(carol, `${carol}@example.com`), { ok: false, soleAdminOf: ['Carol team'] })
    assert.equal((await pool.query('select 1 from "user" where id = $1', [carol])).rowCount, 1)
    assert.equal((await pool.query('select 1 from user_facts where "userId" = $1', [carol])).rowCount, 1)

    const removedFiles: string[] = []
    assert.deepEqual(await deletion.deleteAccount(alice, `${alice}@example.com`, {
      externalCleanup: async () => [], deleteObject: async key => { removedFiles.push(key) },
    }), { ok: true })
    assert.deepEqual(removedFiles, [personalFile], 'deletion retires the personal task object and preserves the shared task object')
    assert.deepEqual((await pool.query('select "taskId","storageKey" from task_attachments where "userId"=$1', [alice])).rows,
      [{ taskId: teamIssue, storageKey: teamFile }])

    // Nothing with Alice as its owner is left, in any table (bar the append-only skill ledgers),
    // except her bot in the shared workspace and its threads, which stay for the team.
    const { rows: columns } = await pool.query<{ table: string; column: string }>(
      `select table_name as "table", column_name as "column" from information_schema.columns
       where table_schema = current_schema() and column_name = any($1::text[]) and table_name not like 'improvement\\_%'`, [deletion.OWNER_COLUMNS])
    const left: string[] = []
    for (const { table, column } of columns) {
      // Team issues of the shared workspace keep their owner column; they stay on purpose.
      if (['issues', 'issue_documents', 'task_attachments', 'mikka_team_issues', 'mikka_teams', 'mikka_workspaces'].includes(table)) continue
      if (['bots', 'agent_runs', 'agents', 'run_messages', 'artifacts'].includes(table)) continue
      if (['task_identifier_aliases', 'mikka_task_identifier_aliases'].includes(table)) {
        const aliases = (await pool.query(`select distinct "issueId" from "${table}" where "ownerId"=$1`, [alice])).rows
        assert.deepEqual(aliases, [{ issueId: teamIssue }], `${table} retains the shared Task's historical author without retaining the deleted personal Task`)
        continue
      }
      // Access evidence and the ACL of retained sources stay without turning
      // those sources public; verify those privacy guarantees below.
      if (['resource_access_policies', 'resource_access_events'].includes(table)) continue
      const { rowCount } = await pool.query(`select 1 from "${table}" where "${column}" = $1 limit 1`, [alice])
      if (rowCount) left.push(`${table}.${column}`)
    }
    assert.deepEqual(left, [])
    assert.equal((await pool.query('select 1 from "user" where id = $1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issues where id = $1', [personalIssue])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issue_documents where "issueId" = $1', [personalIssue])).rowCount, 0)
    assert.equal((await pool.query('select 1 from issue_members where "memberId" = $1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from artifact_shares where "createdBy" = $1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from resource_access_grants where "subjectKind"=\'account\' and "subjectId"=$1', [alice])).rowCount, 0)
    assert.equal((await pool.query('select 1 from resource_access_policies where kind=\'task\' and id=$1', [personalIssue])).rowCount, 0)
    assert.equal((await pool.query('select visibility from resource_access_policies where kind=\'thread\' and id=$1', [run])).rows[0].visibility, 'private')
    assert.equal((await pool.query('select mikka_resource_acl_allowed(\'account\',$1,$2,\'thread\',$3,\'canReadContent\') as allowed', [bob, shared, run])).rows[0].allowed, false, 'account deletion does not grant administrators private history')
    const retainedPolicies = (await pool.query('select kind,id,visibility from resource_access_policies where "workspaceId"=$1 and id=any($2::uuid[]) order by kind,id', [shared, [teamIssue, bot, run, liveRun, artifact]])).rows
    assert.deepEqual(retainedPolicies, [
      { kind: 'task', id: teamIssue, visibility: 'shared' },
      { kind: 'bot', id: bot, visibility: 'private' },
      { kind: 'thread', id: run, visibility: 'private' },
      { kind: 'thread', id: liveRun, visibility: 'private' },
      { kind: 'artifact', id: artifact, visibility: 'private' },
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), 'retained sources keep their exact ACL and never inherit new sharing from account deletion')

    // Her bot in the shared workspace stays, paused with no owner (「待接管」), with its threads, their messages and Artifacts and the agent they ran on.
    const [kept] = (await pool.query<{ ownerId: string | null; archivedAt: Date | null }>('select "ownerId", "archivedAt" from bots where id = $1', [bot])).rows
    assert.equal(kept.ownerId, null); assert.ok(kept.archivedAt, 'paused for an admin to take over')
    assert.deepEqual((await pool.query('select id, status from agent_runs where "botId" = $1 order by id', [bot])).rows,
      [{ id: run, status: 'done' }, { id: liveRun, status: 'stopped' }].sort((a, b) => a.id.localeCompare(b.id)))
    assert.equal((await pool.query('select 1 from run_messages where "runId" = $1', [run])).rowCount, 1)
    assert.equal((await pool.query('select 1 from artifacts where id = $1', [artifact])).rowCount, 1)
    assert.equal((await pool.query('select 1 from agents where id = $1', [agent])).rowCount, 1)
    assert.equal((await pool.query('select 1 from run_tokens where "runId" = $1', [liveRun])).rowCount, 0, 'credentials of a kept thread still go')
    assert.equal((await pool.query('select 1 from bot_desktops where "botId" = $1 union all select 1 from bot_subagents where "botId" = $1', [bot])).rowCount, 0, 'rows bound to the old owner go')
    // Her bot in her own workspace and her Coordinator go with their threads.
    assert.equal((await pool.query('select 1 from bots where id = any($1::uuid[])', [[soloBot, coordinator]])).rowCount, 0)
    assert.equal((await pool.query('select 1 from agent_runs where id = any($1::uuid[])', [[soloRun, coordinatorRun]])).rowCount, 0)
    assert.equal((await pool.query('select 1 from run_messages where "runId" = $1', [soloRun])).rowCount, 0)

    // The bot list shows it with no owner, and 用量 groups it under 「待接管」.
    const { workspaceBots } = await import('../workspace-admin/bots')
    const listed = (await workspaceBots(shared)).find(row => row.id === bot)
    assert.deepEqual(listed && { ownerId: listed.ownerId, ownerName: listed.ownerName }, { ownerId: null, ownerName: null })
    const { workspaceUsage } = await import('../usage/read')
    const month = new Date().toISOString().slice(0, 7)
    const usage = await workspaceUsage(bob, shared, month)
    assert.ok(usage.bots.some(row => row.id === bot && row.ownerId === null))
    assert.deepEqual(usage.members.filter(row => row.awaitingTakeover).map(row => [row.id, row.name]), [['', '']])

    // A null owner matches nobody: no one, member or admin, can use or edit it as its owner.
    const { updateOwnedBot } = await import('../bot-update')
    for (const actor of [bob, dave]) await assert.rejects(updateOwnedBot({ ownerId: actor, workspaceId: shared }, { botId: bot, name: 'Mine now' }), /botNotFound/)
    const { botInstructions } = await import('../coordinator/bot-instructions')
    assert.equal(await botInstructions(bob, bot, 'base'), 'base', 'not treated as Bob\'s bot')
    const { takeOverBot, archivedBots } = await import('../workspace-admin/members')
    const { WorkspaceError } = await import('../workspace-access')
    // Dave is a plain member of the shared workspace: he can neither list paused bots nor take one over.
    await pool.query(`insert into mikka_workspace_members ("workspaceId", "userId", name, email, role) values ($1, $2, $2, $3, 'member')`, [shared, dave, `${dave}@example.com`])
    await assert.rejects(archivedBots(dave, shared), (error: unknown) => error instanceof WorkspaceError)
    await assert.rejects(takeOverBot(dave, shared, bot), (error: unknown) => error instanceof WorkspaceError)
    await pool.query('delete from mikka_workspace_members where "workspaceId" = $1 and "userId" = $2', [shared, dave])
    // Bob, an admin there, takes it over as from any member who left: it runs again, as his, with its threads.
    assert.deepEqual((await archivedBots(bob, shared)).map(row => [row.id, row.ownerId]), [[bot, null]])
    assert.deepEqual(await takeOverBot(bob, shared, bot), { bots: 1 })
    assert.deepEqual((await pool.query('select "ownerId", "archivedAt" from bots where id = $1', [bot])).rows, [{ ownerId: bob, archivedAt: null }])
    assert.equal((await pool.query('select 1 from agent_runs where "botId" = $1', [bot])).rowCount, 2)
    await updateOwnedBot({ ownerId: bob, workspaceId: shared }, { botId: bot, name: 'Helper 2' })

    // Her solo workspace went; the shared one, its team issue and group chat stay for Bob.
    assert.equal((await pool.query('select 1 from mikka_workspaces where id = $1', [solo])).rowCount, 0)
    assert.deepEqual((await pool.query<{ userId: string }>('select "userId" from mikka_workspace_members where "workspaceId" = $1', [shared])).rows, [{ userId: bob }])
    assert.equal((await pool.query('select 1 from issues where id = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from issue_documents where "issueId" = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from mikka_team_issues where "issueId" = $1', [teamIssue])).rowCount, 1)
    assert.equal((await pool.query('select 1 from conversations where id = $1', [group])).rowCount, 1)
    assert.equal((await pool.query('select 1 from conversations where id = $1', [dm])).rowCount, 0)
    assert.deepEqual((await pool.query<{ memberId: string }>('select "memberId" from conversation_members where "conversationId" = $1', [group])).rows, [{ memberId: bob }])
    // No row keyed by her solo workspace is left; the shared workspace keeps its secrets, key, settings and allowance.
    const { KEPT_WITH_WORKSPACE, WORKSPACE_COLUMNS } = await import('../workspace-rows')
    const { rows: keyed } = await pool.query<{ table: string; column: string }>(
      `select table_name as "table", column_name as "column" from information_schema.columns where table_schema = current_schema() and column_name = any($1::text[])`, [WORKSPACE_COLUMNS])
    const keyedBy = async (wid: string) => {
      const found: string[] = []
      for (const { table, column } of keyed) {
        if (KEPT_WITH_WORKSPACE.has(table)) continue
        if ((await pool.query(`select 1 from "${table}" where "${column}"::text = $1 limit 1`, [wid])).rowCount) found.push(table)
      }
      return found.sort()
    }
    assert.deepEqual(await keyedBy(solo), [])
    assert.equal((await pool.query('select 1 from workspace_deletions where id = $1', [solo])).rowCount, 1, 'her solo workspace\'s deletion is recorded for its audit log')
    assert.equal((await pool.query('select 1 from workspace_deletions where id = $1', [shared])).rowCount, 0)
    assert.equal((await pool.query('select 1 from bots where id = $1', [formerBot])).rowCount, 0)
    // The shared workspace keeps its own rows, and her team bot stays there without an owner (「待接管」).
    assert.deepEqual(await keyedBy(shared), ['agent_runs', 'artifacts', 'bots', 'conversations', 'hosted_allowances', 'issues', 'mikka_task_identifier_aliases', 'resource_access_policies', 'task_identifier_aliases', 'workspace_e2b_keys', 'workspace_secrets', 'workspace_settings', 'workspace_task_identifier_counters'])
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

dbTest('account deletion freezes ungrouped Shared and unresolved tasks after membership removal without deleting contributed history', async t => {
  const { createRequestDatabaseScope, pool, deletion } = await load()
  const scope = createRequestDatabaseScope(databaseUrl!)
  const subject = `test-retained-subject-${randomUUID()}`, peer = `test-retained-peer-${randomUUID()}`
  const taskIds: string[] = [], workspaceIds: string[] = []
  const fault = `retention_fault_${randomUUID().replaceAll('-', '')}`
  t.after(async () => {
    await scope.run(async () => {
      await pool.query(`DROP TRIGGER IF EXISTS "${fault}" ON account_deletion_jobs`)
      await pool.query(`DROP FUNCTION IF EXISTS "${fault}"()`)
      for (const table of ['issue_members', 'issue_documents', 'issue_versions']) await pool.query(`DELETE FROM ${table} WHERE "issueId"=ANY($1::uuid[])`, [taskIds])
      await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [taskIds])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[subject, peer]])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await addUser(pool, subject); await addUser(pool, peer)
    const personal = await seedFixtureWorkspace(pool, subject)
    const shared = await seedFixtureWorkspace(pool, peer, 'team')
    const departed = await seedFixtureWorkspace(pool, peer, 'team')
    workspaceIds.push(personal, shared, departed)
    for (const workspaceId of [shared, departed]) await pool.query(
      'INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')',
      [workspaceId, subject, `${subject}@example.com`])
    const issue = async (owner: string, workspaceId: string | null) => {
      const id = randomUUID()
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'Retained task\',\'{"type":"doc"}\',\'todo\',\'normal\',\'personal\')', [id, owner, workspaceId])
      taskIds.push(id)
      return id
    }
    const personalTask = await issue(subject, personal), sharedTask = await issue(subject, shared)
    const departedTask = await issue(subject, departed), contributedTask = await issue(peer, shared)
    const pendingTask = await issue(subject, null)
    for (const issueId of taskIds) {
      await pool.query('INSERT INTO issue_documents("issueId","userId",state) VALUES($1,$2,$3)', [issueId, subject, `document-${issueId}`])
      await pool.query(`INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id)
        SELECT $1,id,$2,revision,title,content,status,priority,'user',$2 FROM issues WHERE id=$3`, [randomUUID(), subject, issueId])
      await pool.query('INSERT INTO issue_members("issueId","userId","memberId") SELECT id,"userId",$2 FROM issues WHERE id=$1', [issueId, subject])
    }
    await pool.query('INSERT INTO issue_members("issueId","userId","memberId") VALUES($1,$2,$3)', [sharedTask, subject, peer])
    const sessionId = `retention-session-${randomUUID()}`
    await pool.query('INSERT INTO session(id,token,"userId","createdAt","updatedAt","expiresAt") VALUES($1,$2,$3,now(),now(),now()+interval \'1 day\')', [sessionId, randomUUID(), subject])
    assert.equal((await pool.query('SELECT count(*)::int n FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[])', [taskIds])).rows[0].n, 0)

    const { issueForUser } = await import('../issue-access')
    const { tokenWorkspace } = await import('../tokens/principal')
    const reader = (id: string, workspaceId: string) => ({ id, [tokenWorkspace]: workspaceId })
    assert.ok(await issueForUser(reader(subject, shared), sharedTask))
    assert.ok(await issueForUser(reader(subject, departed), departedTask))
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [departed, subject])
    assert.equal(await issueForUser(reader(subject, departed), departedTask), null, 'a creator loses access as soon as membership is removed')
    assert.ok(await issueForUser(reader(peer, departed), departedTask))
    assert.equal(await issueForUser(reader(subject, personal), pendingTask), null, 'pending is not inferred as the creator personal tenant')
    const before = {
      tasks: (await pool.query('SELECT id,"userId","workspaceId","ownershipState",content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows,
      documents: (await pool.query('SELECT * FROM issue_documents WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])).rows,
      versions: (await pool.query('SELECT * FROM issue_versions WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId",id', [taskIds])).rows,
    }
    const { requestAccountDeletion, resumeAccountDeletion } = await import('./deletion-jobs')
    const options = { externalCleanup: async () => [] as string[] }
    const requested = await requestAccountDeletion(subject, `${subject}@example.com`, randomUUID(), options)
    assert.ok(requested.ok)
    const planned = (await pool.query<{ plan: import('./delete').Plan }>('SELECT plan FROM account_deletion_jobs WHERE id=$1', [requested.id])).rows[0].plan
    assert.deepEqual(planned.solo, [personal])
    assert.deepEqual(planned.shared, [shared], 'the former membership is absent from the Workspace plan')
    assert.deepEqual(planned.keptIssueIds, [], 'Team links do not authorize retention before APP row locks')

    const transaction = await pool.connect()
    try {
      await transaction.query('BEGIN')
      await assert.rejects(deletion.freezeTaskRetention(transaction, subject, { ...planned, keptIssueIds: [personalTask] }), /accountDeletionTaskRetentionChanged/)
    } finally { await transaction.query('ROLLBACK'); transaction.release() }

    // Fail the stage write after the deletes: tasks and the retained journal must roll back together.
    await pool.query(`CREATE FUNCTION "${fault}"() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture_retention_commit_refused'; END;$$`)
    await pool.query(`CREATE TRIGGER "${fault}" BEFORE UPDATE OF stage ON account_deletion_jobs
      FOR EACH ROW WHEN (NEW.id='${requested.id}'::uuid AND NEW.stage='main_deleted') EXECUTE FUNCTION "${fault}"()`)
    try {
      await assert.rejects(resumeAccountDeletion(requested.id, options), /fixture_retention_commit_refused/)
      assert.deepEqual((await pool.query('SELECT id,"userId","workspaceId","ownershipState",content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows, before.tasks)
      assert.deepEqual((await pool.query('SELECT * FROM issue_documents WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])).rows, before.documents)
      assert.deepEqual((await pool.query('SELECT * FROM issue_versions WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId",id', [taskIds])).rows, before.versions)
      assert.equal((await pool.query('SELECT count(*)::int n FROM session WHERE id=$1', [sessionId])).rows[0].n, 1)
      const rolledBack = (await pool.query('SELECT stage,plan FROM account_deletion_jobs WHERE id=$1', [requested.id])).rows[0]
      assert.equal(rolledBack.stage, 'external_pending')
      assert.deepEqual(rolledBack.plan.keptIssueIds, [])
    } finally {
      await pool.query(`DROP TRIGGER "${fault}" ON account_deletion_jobs`)
      await pool.query(`DROP FUNCTION "${fault}"()`)
    }

    const completed = await resumeAccountDeletion(requested.id, options)
    assert.equal(completed.stage, 'completed')
    const retained = [sharedTask, departedTask, contributedTask, pendingTask].sort()
    assert.deepEqual(completed.plan?.keptIssueIds, retained)
    assert.deepEqual((await resumeAccountDeletion(requested.id, options)).plan, completed.plan, 'retry preserves the committed retention decision')
    assert.deepEqual((await pool.query('SELECT id,"userId","workspaceId","ownershipState",content FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id', [taskIds])).rows, before.tasks.filter(row => row.id !== personalTask))
    assert.deepEqual((await pool.query('SELECT * FROM issue_documents WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [taskIds])).rows, before.documents.filter(row => row.issueId !== personalTask))
    assert.deepEqual((await pool.query('SELECT * FROM issue_versions WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId",id', [taskIds])).rows, before.versions.filter(row => row.issueId !== personalTask))
    assert.equal((await pool.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [personal])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [subject])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM session WHERE id=$1', [sessionId])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM issue_members WHERE "memberId"=$1', [subject])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM issue_members WHERE "issueId"=$1 AND "memberId"=$2', [sharedTask, peer])).rows[0].n, 1)
    assert.equal(await issueForUser(reader(subject, shared), sharedTask), null)
    assert.equal(await issueForUser(reader(subject, departed), departedTask), null)
    assert.ok(await issueForUser(reader(peer, shared), sharedTask))
    assert.ok(await issueForUser(reader(peer, departed), departedTask))
    assert.ok(await issueForUser(reader(peer, shared), contributedTask))
    assert.equal(await issueForUser(reader(peer, shared), pendingTask), null)
  })
})


dbTest('account deletion preserves task run and Factory history through DELETE user while ending all execution authority', async t => {
  const { createRequestDatabaseScope, pool, deletion } = await load()
  const scope = createRequestDatabaseScope(databaseUrl!)
  const subject = 'test-run-history-' + randomUUID(), peer = 'test-run-peer-' + randomUUID()
  const agent = randomUUID(), device = randomUUID(), sharedBot = randomUUID(), personalBot = randomUUID(), coordinator = randomUUID()
  const taskIds: string[] = [], workspaceIds: string[] = [], artifactIds: string[] = [], captureIds: string[] = [], runIds: string[] = []
  const factoryIds: string[] = [], sourceEvents: string[] = [], operationIds: string[] = [], mailboxIds: string[] = []
  const removedObjects: string[] = []
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('DELETE FROM factory_tasks WHERE id=ANY($1::uuid[])', [factoryIds])
      await pool.query('DELETE FROM artifacts WHERE id=ANY($1::uuid[])', [artifactIds])
      await pool.query('DELETE FROM run_messages WHERE "runId"=ANY($1::uuid[])', [runIds])
      await pool.query('WITH removed_mailboxes AS (DELETE FROM session_mailboxes WHERE id=ANY($2::uuid[]) RETURNING id) DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [runIds, mailboxIds])
      await pool.query('DELETE FROM coordinator_events WHERE id=ANY($1::uuid[])', [sourceEvents])
      await pool.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[sharedBot, personalBot, coordinator]])
      await pool.query('DELETE FROM agents WHERE id=$1', [agent])
      await pool.query('DELETE FROM operation_ledger WHERE "operationId"=ANY($1::uuid[])', [operationIds])
      for (const table of ['issue_documents', 'issue_versions', 'issue_members']) await pool.query('DELETE FROM ' + table + ' WHERE "issueId"=ANY($1::uuid[])', [taskIds])
      await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [taskIds])
      for (const table of ['hosted_usage', 'workspace_credit_grants', 'workspace_audit_events']) await pool.query('DELETE FROM ' + table + ' WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[subject, peer]])
    })
    await scope.close()
  })
  await scope.run(async () => {
    await addUser(pool, subject); await addUser(pool, peer)
    const personal = await seedFixtureWorkspace(pool, subject)
    const shared = await seedFixtureWorkspace(pool, peer, 'team')
    const departed = await seedFixtureWorkspace(pool, peer, 'team')
    workspaceIds.push(personal, shared, departed)
    for (const workspaceId of [shared, departed]) await pool.query(
      "INSERT INTO mikka_workspace_members(\"workspaceId\",\"userId\",name,email,role,status) VALUES($1,$2,$2,$3,'member','active')",
      [workspaceId, subject, subject + '@example.com'])
    const task = async (owner: string, workspaceId: string) => {
      const id = randomUUID()
      // Deliberately the same old provider scope in both tenants.
      await pool.query("INSERT INTO issues(id,\"userId\",\"workspaceId\",title,content,status,priority,scope) VALUES($1,$2,$3,'History task','{\"type\":\"doc\"}','todo','normal','personal')", [id, owner, workspaceId])
      taskIds.push(id)
      return id
    }
    const sharedTask = await task(subject, shared), departedTask = await task(peer, departed)
    const artifactOnlyTask = await task(peer, shared), personalTask = await task(subject, personal)
    await pool.query("INSERT INTO devices(id,\"ownerId\",name) VALUES($1,$2,'History device')", [device, subject])
    await pool.query("INSERT INTO agents(id,\"userId\",harness,name,\"deviceId\") VALUES($1,$2,'codex','History agent',$3)", [agent, subject, device])
    await pool.query("INSERT INTO bots(id,\"workspaceId\",\"ownerId\",name) VALUES($1,$4,$6,'Shared bot'),($2,$5,$6,'Personal bot'),($3,$4,$6,'Coordinator')", [sharedBot, personalBot, coordinator, shared, personal, subject])
    await pool.query('INSERT INTO coordinator_bots("ownerId","workspaceId","botId") VALUES($1,$2,$3)', [subject, shared, coordinator])
    const sessionId = 'history-session-' + randomUUID()
    await pool.query("INSERT INTO session(id,token,\"userId\",\"createdAt\",\"updatedAt\",\"expiresAt\") VALUES($1,$2,$3,now(),now(),now()+interval '1 day')", [sessionId, randomUUID(), subject])
    const fixtures = [
      { name: 'shared-bot', issueId: sharedTask, workspaceId: shared, botId: sharedBot, status: 'succeeded', keep: true },
      { name: 'shared-no-bot', issueId: sharedTask, workspaceId: shared, botId: null, status: 'succeeded', keep: true },
      { name: 'shared-coordinator-task', issueId: sharedTask, workspaceId: shared, botId: coordinator, status: 'succeeded', keep: true },
      { name: 'shared-active', issueId: sharedTask, workspaceId: shared, botId: null, status: 'running', keep: true },
      { name: 'departed-no-bot', issueId: departedTask, workspaceId: departed, botId: null, status: 'succeeded', keep: true },
      { name: 'personal-bot', issueId: personalTask, workspaceId: personal, botId: personalBot, status: 'succeeded', keep: false },
      { name: 'personal-no-bot', issueId: personalTask, workspaceId: personal, botId: null, status: 'succeeded', keep: false },
    ].map(item => ({ ...item, id: randomUUID(), artifact: randomUUID(), capture: randomUUID(), keys: [] as string[] }))
    for (const run of fixtures) {
      runIds.push(run.id); artifactIds.push(run.artifact); captureIds.push(run.capture)
      run.keys = ['fixture/history/' + subject + '/' + run.name + '.md', 'fixture/history/' + subject + '/' + run.name + '.png']
      await pool.query("INSERT INTO agent_runs(id,\"userId\",\"agentId\",\"deviceId\",\"workspaceId\",\"issueId\",\"botId\",status,prompt,report,\"leaseExpiresAt\",\"finishedAt\") VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Private prompt','{\"summary\":\"Private report\"}',CASE WHEN $8='running' THEN now()+interval '1 hour' END,CASE WHEN $8<>'running' THEN now() END)",
        [run.id, subject, agent, device, run.workspaceId, run.issueId, run.botId, run.status])
      await pool.query("INSERT INTO run_messages(id,\"runId\",\"userId\",text) VALUES($1,$2,$3,'Private transcript')", [randomUUID(), run.id, subject])
      await pool.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt") VALUES($1,$2,$3,$4,1,now())', [run.id, subject, 'a'.repeat(40), Buffer.from('checkpoint-' + run.name)])
      await pool.query("INSERT INTO artifacts(id,\"userId\",\"workspaceId\",\"runId\",\"issueId\",kind,title) VALUES($1,$2,$3,$4,$5,'markdown','History artifact')", [run.artifact, subject, run.workspaceId, run.id, run.issueId])
      await pool.query("INSERT INTO artifact_versions(id,\"artifactId\",version,\"storageKey\",\"inlineContent\",sha256,size,\"authorName\") VALUES($1,$2,1,$3,'Retained artifact',$4,17,'Fixture author')", [randomUUID(), run.artifact, run.keys[0], 'a'.repeat(64)])
      await pool.query("INSERT INTO run_captures(id,\"userId\",\"runId\",\"issueId\",\"botId\",kind,\"contentType\",source,status,title,\"storageKey\",size,sha256) VALUES($1,$2,$3,$4,$5,'image','image/png','cloud_computer','ready','History capture',$6,12,$7)", [run.capture, subject, run.id, run.issueId, run.botId, run.keys[1], 'b'.repeat(64)])
      await pool.query("INSERT INTO run_capture_steps(id,\"captureId\",\"userId\",\"atMs\",label,source) VALUES($1,$2,$3,0,'Completed step','mark')", [randomUUID(), run.capture, subject])
      const publicationStatus = run.status === 'running' ? 'processing' : 'published'
      await pool.query("INSERT INTO run_publications(\"runId\",\"userId\",\"issueId\",\"scopeVersion\",\"issueTitle\",\"remoteUrl\",\"remoteKey\",branch,\"pushApproved\",status,\"leaseToken\",\"leaseExpiresAt\",\"pullRequest\") VALUES($1,$2,$3,1,'History task','https://github.com/fixture/repository.git','github.com/fixture/repository','fixture/history',true,$4,$5,CASE WHEN $4='processing' THEN now()+interval '1 hour' END,$6)",
        [run.id, subject, run.issueId, publicationStatus, publicationStatus === 'processing' ? randomUUID() : null,
          publicationStatus === 'published' ? { url: 'https://github.com/fixture/repository/pull/1', state: 'merged' } : null])
      await pool.query("INSERT INTO run_tokens(id,\"runId\",\"userId\",\"tokenHash\",\"expiresAt\") VALUES($1,$2,$3,$4,now()+interval '1 hour')", [randomUUID(), run.id, subject, randomUUID()])
      await pool.query('INSERT INTO artifact_shares(id,"artifactId","tokenHash","createdBy") VALUES($1,$2,$3,$4)', [randomUUID(), run.artifact, randomUUID(), subject])
      await pool.query('INSERT INTO run_capture_shares(id,"captureId","tokenHash","createdBy") VALUES($1,$2,$3,$4)', [randomUUID(), run.capture, randomUUID(), subject])
    }
    const byName = (name: string) => fixtures.find(run => run.name === name)!
    const mailboxFixtures = [byName('shared-no-bot'), byName('personal-no-bot')].map(run => ({ id: randomUUID(), run }))
    for (const { id, run } of mailboxFixtures) {
      mailboxIds.push(id)
      await pool.query('INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey","latestRunId","wakeBudget") VALUES($1,$2,$3,\'run\',$4,$5,3)', [id, subject, run.workspaceId, run.id, run.id])
      await pool.query('UPDATE agent_runs SET "mailboxId"=$1 WHERE id=$2', [id, run.id])
      await pool.query('UPDATE run_messages SET "mailboxId"=$1 WHERE "runId"=$2', [id, run.id])
    }
    await pool.query('UPDATE agent_runs SET "retryOf"=$1,"continuesRunId"=$1,"threadReplacedBy"=$1 WHERE id=$2', [byName('personal-bot').id, byName('personal-no-bot').id])
    const direct = [
      { id: randomUUID(), issueId: artifactOnlyTask, workspaceId: shared, keep: true, key: 'fixture/history/' + subject + '/direct-shared.md' },
      { id: randomUUID(), issueId: personalTask, workspaceId: personal, keep: false, key: 'fixture/history/' + subject + '/direct-personal.md' },
    ]
    for (const item of direct) {
      artifactIds.push(item.id)
      await pool.query("INSERT INTO artifacts(id,\"userId\",\"workspaceId\",\"issueId\",kind,title) VALUES($1,$2,$3,$4,'markdown','Direct task artifact')", [item.id, subject, item.workspaceId, item.issueId])
      await pool.query("INSERT INTO artifact_versions(id,\"artifactId\",version,\"storageKey\",\"inlineContent\",sha256,size,\"authorName\") VALUES($1,$2,1,$3,'Direct task file',$4,16,'Fixture author')", [randomUUID(), item.id, item.key, 'c'.repeat(64)])
    }
    for (const status of ['pending', 'approved']) await pool.query("INSERT INTO agent_tool_approvals(id,\"runId\",\"userId\",\"deviceId\",\"requestId\",harness,method,input,digest,status,\"expiresAt\") VALUES($1,$2,$3,$4,$5,'codex','command','{}',$6,$7,now()+interval '1 hour')",
      [randomUUID(), byName('shared-active').id, subject, device, randomUUID(), 'd'.repeat(64), status])

    const factory = async (run: typeof fixtures[number], status: 'passed' | 'pending') => {
      const id = randomUUID(), attemptId = randomUUID(), candidateId = randomUUID(), eventId = randomUUID(), approvalId = randomUUID(), publicationId = randomUUID()
      factoryIds.push(id); sourceEvents.push(eventId)
      await pool.query("INSERT INTO coordinator_events(id,\"userId\",\"botId\",kind,\"dedupeKey\",\"issueId\",payload,\"deliveredAt\",\"wakeLeaseUntil\") VALUES($1,$2,$3,'user_message',$4,$5,'{\"text\":\"Frozen source\"}',now(),now()+interval '1 hour')", [eventId, subject, run.botId, randomUUID(), run.issueId])
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("INSERT INTO factory_tasks(id,\"userId\",\"workspaceId\",\"botId\",\"issueId\",\"sourceEventId\",route,stage,status,revision,\"attemptId\",reason) VALUES($1,$2,$3,$4,$5,$6,$7,'publish',$8,1,$9,'Fixture history')",
          [id, subject, run.workspaceId, run.botId, run.issueId, eventId, { issueId: run.issueId, sourceEventId: eventId, eventId, rationale: 'Fixture history', missingInformation: [], missingPermissions: [], needsSpec: false }, status, attemptId])
        await client.query("INSERT INTO factory_candidates(id,\"taskId\",sha,repository,environment,scope,\"runId\") VALUES($1,$2,$3,'fixture/repository','test','fixture',$4)", [candidateId, id, 'a'.repeat(40), run.id])
        await client.query("INSERT INTO factory_attempts(id,\"taskId\",stage,ordinal,position,status,\"candidateId\",\"runId\",\"sessionId\",reason,\"finishedAt\") VALUES($1,$2,'publish',1,1,$3,$4,$5,$6,'Fixture history',CASE WHEN $3='passed' THEN now() END)",
          [attemptId, id, status, candidateId, run.id, sessionId])
        await client.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [id, candidateId])
        await client.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [id, eventId, { kind: 'fixture' }, { retained: true }])
        const request = { binding: { taskId: id, revision: 1 }, targetEnvironment: 'test' }
        const candidate = { sha: 'a'.repeat(40), repository: 'fixture/repository', environment: 'test', scope: 'fixture' }
        await client.query("INSERT INTO factory_approvals(id,\"taskId\",\"candidateId\",\"attemptId\",\"userId\",\"principalId\",\"humanSessionId\",\"eventId\",request,candidate,action,target,evidence,\"approvedRevision\",\"publishAttemptId\",\"publishRevision\",\"expiresAt\") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'merge','fixture/repository','[]',1,$4,1,now()+interval '1 hour')",
          [approvalId, id, candidateId, attemptId, subject, 'session:' + sessionId, sessionId, randomUUID(), request, candidate])
        const receipt = { reference: 'https://github.com/fixture/repository/pull/1', verifiedTarget: { kind: 'merge', operationId: publicationId, target: 'fixture/repository', environment: 'test', repository: 'fixture/repository', sha: candidate.sha, reference: 'https://github.com/fixture/repository/pull/1', observedAt: new Date().toISOString() } }
        await client.query("INSERT INTO factory_publications(id,\"approvalId\",\"taskId\",\"candidateId\",action,target,\"eventId\",request,status,receipt,result,\"finishedAt\") VALUES($1,$2,$3,$4,'merge','fixture/repository',$5,$6,$7,$8,$9,CASE WHEN $7='succeeded' THEN now() END)",
          [publicationId, approvalId, id, candidateId, randomUUID(), request, status === 'passed' ? 'succeeded' : 'reserved', status === 'passed' ? receipt : null, status === 'passed' ? { published: true } : null])
        await client.query('INSERT INTO factory_evidence_reads(id,"taskId","userId","humanSessionId","principalId",binding,"evidenceDigest") VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), id, subject, sessionId, 'session:' + sessionId, request.binding, 'c'.repeat(64)])
        await client.query('INSERT INTO factory_approval_controls("taskId","eventId","userId","principalId","humanSessionId",request,result) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, randomUUID(), subject, 'session:' + sessionId, sessionId, request, { retained: true }])
        await client.query('INSERT INTO factory_acceptance_artifacts("taskId","artifactId","candidateId","runId",sha256) VALUES($1,$2,$3,$4,$5)', [id, run.artifact, candidateId, run.id, 'a'.repeat(64)])
        await client.query("INSERT INTO factory_stage_updates(\"taskId\",stage,\"commentId\",\"bodyHash\") VALUES($1,'handoff',$2,$3)", [id, randomUUID(), 'a'.repeat(64)])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      return { id, attemptId, candidateId, approvalId, publicationId, eventId }
    }
    const completedFactory = await factory(byName('shared-coordinator-task'), 'passed')
    const activeFactory = await factory(byName('shared-no-bot'), 'pending')
    const personalFactory = await factory(byName('personal-no-bot'), 'passed')
    for (const status of ['succeeded', 'reserved', 'executing'] as const) {
      const id = randomUUID(), runId = byName('shared-no-bot').id
      operationIds.push(id)
      await pool.query("INSERT INTO pending_actions(id,\"userId\",action,input,status) VALUES($1,$2,'send_slack_message','{\"text\":\"Fixture only\"}','running')", [id, subject])
      const binding = { operationId: id, ownerId: subject, workspaceId: 'personal:' + subject, provider: 'fixture', accountId: 'fixture', action: 'send_slack_message', target: 'fixture', executionRunId: runId, approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64) }
      await pool.query('INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId",receipt,"invokedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, subject, 'personal:' + subject, binding, randomUUID(), status, status === 'reserved' ? null : randomUUID(), status === 'reserved' ? null : runId,
          status === 'succeeded' ? { providerObjectId: 'fixture-result', evidenceDigest: 'c'.repeat(64) } : null, status === 'reserved' ? null : new Date()])
    }
    await pool.query("INSERT INTO hosted_usage(id,\"workspaceId\",model,state,\"costMicroUsd\",\"settledAt\") VALUES($1,$2,'fixture','settled',23,now())", [randomUUID(), shared])
    await pool.query("INSERT INTO workspace_credit_grants(id,\"workspaceId\",bucket,points,reason,\"externalId\") VALUES($1,$2,'plan',5,'fixture',$3)", [randomUUID(), shared, randomUUID()])
    await pool.query("INSERT INTO workspace_audit_events(id,\"workspaceId\",\"actorType\",\"actorId\",\"actorName\",action,category) VALUES($1,$2,'user',$3,'Fixture author','billing.credit_granted','billing')", [randomUUID(), shared, subject])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [departed, subject])
    assert.equal((await pool.query('SELECT count(*)::int n FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[])', [taskIds])).rows[0].n, 0)
    const keptRuns = fixtures.filter(run => run.keep).map(run => run.id)
    const keptArtifacts = [...fixtures.filter(run => run.keep).map(run => run.artifact), direct[0].id]
    const keptCaptures = fixtures.filter(run => run.keep).map(run => run.capture)
    const rows = async (table: string, column: string, ids: string[]) =>
      (await pool.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t WHERE "' + column + '"=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text', [ids])).rows.map(item => item.row)
    const retainedTables: [string, string, string[]][] = [
      ['run_messages', 'runId', keptRuns], ['run_checkpoints', 'runId', keptRuns],
      ['run_capture_steps', 'captureId', keptCaptures], ['artifact_versions', 'artifactId', keptArtifacts],
      ['factory_candidates', 'taskId', [completedFactory.id, activeFactory.id]],
      ['factory_attempts', 'taskId', [completedFactory.id]],
      ['factory_evidence_reads', 'taskId', [completedFactory.id, activeFactory.id]],
      ['factory_approval_controls', 'taskId', [completedFactory.id, activeFactory.id]],
      ['factory_acceptance_artifacts', 'taskId', [completedFactory.id, activeFactory.id]],
      ['factory_stage_updates', 'taskId', [completedFactory.id, activeFactory.id]],
      ['hosted_usage', 'workspaceId', [shared]], ['workspace_credit_grants', 'workspaceId', [shared]], ['workspace_audit_events', 'workspaceId', [shared]],
    ]
    const before = await Promise.all(retainedTables.map(([table, column, ids]) => rows(table, column, ids)))
    const publishedRunIds = fixtures.filter(run => run.keep && run.status === 'succeeded').map(run => run.id)
    const publishedRuns = await rows('run_publications', 'runId', publishedRunIds)
    const publishedFactory = await rows('factory_publications', 'id', [completedFactory.publicationId])
    const completedTask = await rows('factory_tasks', 'id', [completedFactory.id])
    const retainedOperations = await rows('operation_ledger', 'operationId', operationIds)
    assert.equal((await pool.query('SELECT count(*)::int n FROM pending_actions WHERE id=ANY($1::uuid[])', [operationIds])).rows[0].n, 3, 'execution proposals exist before account deletion')
    const options = { externalCleanup: async () => [] as string[], deleteObject: async (key: string) => { removedObjects.push(key) }, now: () => new Date(Date.now() + 60_000) }
    assert.deepEqual(await deletion.deleteAccount(subject, subject + '@example.com', options), { ok: true })
    assert.equal((await pool.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [subject])).rows[0].n, 0, 'the actual final user DELETE committed')
    assert.equal((await pool.query('SELECT count(*)::int n FROM session WHERE id=$1', [sessionId])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM devices WHERE id=$1', [device])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM run_tokens WHERE "userId"=$1', [subject])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM artifact_shares WHERE "createdBy"=$1', [subject])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM run_capture_shares WHERE "createdBy"=$1', [subject])).rows[0].n, 0)
    assert.deepEqual((await pool.query('SELECT id,"latestRunId",disabled,"wakeBudget" FROM session_mailboxes WHERE id=ANY($1::uuid[])', [mailboxIds])).rows,
      [{ id: mailboxFixtures[0].id, latestRunId: byName('shared-no-bot').id, disabled: true, wakeBudget: 0 }], 'only the disabled Shared history mailbox survives the actual Run/mailbox cycle deletion')
    assert.equal((await pool.query('SELECT "mailboxId" FROM agent_runs WHERE id=$1', [byName('shared-no-bot').id])).rows[0].mailboxId, mailboxFixtures[0].id)
    assert.deepEqual((await pool.query('SELECT id FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [runIds])).rows.map(row => row.id), [...keptRuns].sort())
    assert.deepEqual((await pool.query('SELECT id FROM artifacts WHERE id=ANY($1::uuid[]) ORDER BY id', [artifactIds])).rows.map(row => row.id), [...keptArtifacts].sort())
    assert.deepEqual((await pool.query('SELECT id FROM run_captures WHERE id=ANY($1::uuid[]) ORDER BY id', [captureIds])).rows.map(row => row.id), [...keptCaptures].sort())
    assert.equal((await pool.query('SELECT count(*)::int n FROM agents WHERE id=$1', [agent])).rows[0].n, 1, 'retained runs keep their required agent parent')
    assert.deepEqual(await Promise.all(retainedTables.map(([table, column, ids]) => rows(table, column, ids))), before)
    assert.deepEqual(await rows('run_publications', 'runId', publishedRunIds), publishedRuns, 'published receipts survive user deletion unchanged')
    assert.deepEqual(await rows('factory_publications', 'id', [completedFactory.publicationId]), publishedFactory)
    assert.deepEqual(await rows('factory_tasks', 'id', [completedFactory.id]), completedTask, 'completed Factory outcome is historical evidence')
    assert.deepEqual(await rows('operation_ledger', 'operationId', operationIds), retainedOperations, 'the ledger retains the last observed result without inventing a new outcome')
    const activeRun = (await pool.query('SELECT status,"leaseExpiresAt","stopRequestedAt","finishedAt" FROM agent_runs WHERE id=$1', [byName('shared-active').id])).rows[0]
    assert.equal(activeRun.status, 'stopped'); assert.equal(activeRun.leaseExpiresAt, null); assert.ok(activeRun.stopRequestedAt); assert.ok(activeRun.finishedAt)
    assert.deepEqual((await pool.query('SELECT status,"pushApproved","leaseToken","leaseExpiresAt","errorCode" FROM run_publications WHERE "runId"=$1', [byName('shared-active').id])).rows,
      [{ status: 'blocked', pushApproved: false, leaseToken: null, leaseExpiresAt: null, errorCode: 'issue_unavailable' }])
    assert.deepEqual((await pool.query('SELECT DISTINCT status FROM agent_tool_approvals WHERE "runId"=$1', [byName('shared-active').id])).rows, [{ status: 'cancelled' }])
    assert.deepEqual((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [activeFactory.id])).rows, [{ status: 'revoked' }])
    assert.deepEqual((await pool.query('SELECT status FROM factory_attempts WHERE id=$1', [activeFactory.attemptId])).rows, [{ status: 'revoked' }])
    assert.deepEqual((await pool.query('SELECT status FROM factory_publications WHERE id=$1', [activeFactory.publicationId])).rows, [{ status: 'uncertain' }])
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_approvals WHERE "taskId"=ANY($1::uuid[]) AND "revokedAt" IS NOT NULL', [[completedFactory.id, activeFactory.id]])).rows[0].n, 2)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_tasks WHERE id=$1', [personalFactory.id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_publications WHERE "taskId"=$1', [personalFactory.id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM pending_actions WHERE "userId"=$1', [subject])).rows[0].n, 0)
    assert.deepEqual((await pool.query('SELECT status,"attemptToken" FROM operation_ledger WHERE "operationId"=$1', [operationIds[1]])).rows, [{ status: 'reserved', attemptToken: null }])
    assert.deepEqual((await pool.query('SELECT status FROM operation_ledger WHERE "operationId"=$1', [operationIds[2]])).rows, [{ status: 'executing' }])
    const { createOperationLedger } = await import('../operations/ledger')
    const { requireOperationSession } = await import('../operations/session-authorization')
    const actor = { userId: subject, sessionId }
    const ledger = createOperationLedger(pool, (tx, binding) => requireOperationSession(tx, actor, binding.ownerId))
    await assert.rejects(ledger.claim({ operationId: operationIds[1], ownerId: subject, workspaceId: 'personal:' + subject }, byName('shared-no-bot').id), /operationSessionUnavailable/)
    await assert.rejects(pool.query("UPDATE operation_ledger SET status='executing',\"attemptToken\"=$2,\"runId\"=$3 WHERE \"operationId\"=$1",
      [operationIds[1], randomUUID(), byName('shared-no-bot').id]), { code: '55000', message: 'account_deletion_pending' }, 'the real database claim write remains fenced after user deletion')
    const { createApprovedWrites } = await import('../operations/approved-writes')
    let providerCalls = 0
    const unavailableProvider = async () => { providerCalls++; throw new Error('deleted account reached the provider') }
    const writes = createApprovedWrites(pool, { name: 'fixture', prepare: unavailableProvider, execute: unavailableProvider, lookup: unavailableProvider }, 'send_slack_message')
    for (const id of operationIds) await assert.rejects(writes.decide(actor, id, true), /operationSessionUnavailable/)
    assert.equal(providerCalls, 0)
    assert.deepEqual(await rows('operation_ledger', 'operationId', operationIds), retainedOperations, 'failed claim and replay attempts leave every retained ledger row unchanged')
    assert.deepEqual((await pool.query('SELECT "botId","wakeLeaseUntil" FROM coordinator_events WHERE id=$1', [completedFactory.eventId])).rows, [{ botId: null, wakeLeaseUntil: null }])
    assert.equal((await pool.query('SELECT count(*)::int n FROM bots WHERE id=ANY($1::uuid[])', [[personalBot, coordinator]])).rows[0].n, 0)
    assert.deepEqual(removedObjects.sort(), [...fixtures.filter(run => !run.keep).flatMap(run => run.keys), direct[1].key].sort())
    const journal = (await pool.query('SELECT id,stage,plan FROM account_deletion_jobs WHERE "subjectUserId"=$1', [subject])).rows[0]
    assert.equal(journal.stage, 'completed')
    assert.deepEqual(journal.plan.keptIssueIds, [sharedTask, departedTask, artifactOnlyTask].sort(), 'run-only and artifact-only contributions participate in the frozen Task decision')
    const { resumeAccountDeletion } = await import('./deletion-jobs')
    assert.equal((await resumeAccountDeletion(journal.id, options)).stage, 'completed')
    assert.deepEqual(await rows('run_publications', 'runId', publishedRunIds), publishedRuns)
    assert.deepEqual(removedObjects.sort(), [...fixtures.filter(run => !run.keep).flatMap(run => run.keys), direct[1].key].sort(), 'completed retries do not repeat object removal')
    const { visibleRuns } = await import('../agent-runs')
    const { tokenWorkspace } = await import('../tokens/principal')
    const reader = (id: string, workspaceId: string) => ({ id, [tokenWorkspace]: workspaceId })
    const visible = await visibleRuns(reader(peer, shared), { issueId: sharedTask })
    assert.deepEqual(visible.map(run => run.id).sort(), fixtures.filter(run => run.workspaceId === shared).map(run => run.id).sort())
    assert.ok(visible.every(run => run.agentId === '' && run.report === null && run.error === null), 'shared membership receives only the existing restricted Run projection')
    assert.deepEqual(await visibleRuns(reader(subject, shared), { issueId: sharedTask }), [])
    assert.equal((await visibleRuns(reader(peer, departed), { issueId: departedTask })).length, 1)
    const { readArtifact, listRunArtifacts } = await import('../artifacts/store')
    assert.equal(await readArtifact(reader(peer, shared), byName('shared-no-bot').artifact), null, 'retaining history does not widen the existing Artifact owner ACL')
    assert.deepEqual(await listRunArtifacts(reader(peer, shared), byName('shared-no-bot').id), [])
    assert.equal(await readArtifact(reader(subject, shared), direct[0].id), null)
    await assert.rejects(pool.query("INSERT INTO run_tokens(id,\"runId\",\"userId\",\"tokenHash\",\"expiresAt\") VALUES($1,$2,$3,$4,now()+interval '1 hour')",
      [randomUUID(), byName('shared-no-bot').id, subject, randomUUID()]), /account_deletion_pending/, 'kept history cannot mint a new execution credential for the deleted subject')
    await assert.rejects(pool.query('INSERT INTO run_messages(id,"runId","userId","mailboxId",text) VALUES($1,$2,$3,$4,\'Must remain fenced\')',
      [randomUUID(), byName('shared-no-bot').id, subject, mailboxFixtures[0].id]), { code: '55000', message: 'account_deletion_pending' }, 'the disabled history mailbox cannot receive a new message for the deleted subject')
    const foreignKeys = (await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='run_publications'::regclass AND contype='f' ORDER BY conname")).rows.map(row => row.conname)
    assert.ok(!foreignKeys.includes('run_publications_userId_fkey'))
    assert.ok(foreignKeys.includes('run_publications_runId_fkey')); assert.ok(foreignKeys.includes('run_publications_issueId_fkey'))
  })
})
