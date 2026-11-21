// Personal workspaces (decision 2026-10-31-2130) against a real PostgreSQL:
// the kind backfill on existing data, invited sign-ups, and who pays for work
// with no workspace of its own.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

const uuidFrom = (seed: string) => {
  const hash = createHash('sha256').update(seed).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

test('personal workspaces', { skip: !dbUrl }, async t => {
  const edition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  t.after(() => {
    if (edition === undefined) delete process.env.MIKKA_EDITION
    else process.env.MIKKA_EDITION = edition
  })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })

  await t.test('the kind migration marks only untouched sign-up workspaces personal, and replays safely', async () => {
    const schema = `personal_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE SCHEMA ${schema}`)
    const scoped = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 1 })
    try {
      // The tables as they were before the migration, with existing rows.
      await scoped.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text NOT NULL, name varchar(120) NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
        CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL, "userId" text NOT NULL, status text NOT NULL DEFAULT 'active', PRIMARY KEY ("workspaceId","userId"));
        CREATE TABLE mikka_workspace_invitations (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, status text NOT NULL)`)
      const seed = async (user: string, id: string, members: Array<[string, string]>, invite = false) => {
        await scoped.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)', [id, user, user])
        for (const [member, status] of members) await scoped.query('INSERT INTO mikka_workspace_members VALUES ($1,$2,$3)', [id, member, status])
        if (invite) await scoped.query(`INSERT INTO mikka_workspace_invitations VALUES ($1,$2,'pending')`, [randomUUID(), id])
      }
      const alone = uuidFrom('orvilo-default:alone'), grown = uuidFrom('orvilo-default:grown'), inviting = uuidFrom('orvilo-default:inviting')
      const created = randomUUID(), suspended = uuidFrom('orvilo-default:suspended'), accepted = uuidFrom('orvilo-default:accepted')
      await seed('alone', alone, [['alone', 'active']])
      await seed('grown', grown, [['grown', 'active'], ['peer', 'active']])
      await seed('inviting', inviting, [['inviting', 'active']], true)
      await seed('created', created, [['created', 'active']])
      await seed('suspended', suspended, [['suspended', 'suspended']])
      await seed('accepted', accepted, [['accepted', 'active']])
      const regrown = uuidFrom('orvilo-default:regrown')
      await seed('regrown', regrown, [['regrown', 'active'], ['peer', 'active']])
      await scoped.query(`INSERT INTO mikka_workspace_invitations VALUES ($1,$2,'accepted')`, [randomUUID(), accepted])
      const migration = await readFile(new URL('../drizzle/20261101020200_personal_workspace_kind.sql', import.meta.url), 'utf8')
      await scoped.query(migration)
      await scoped.query(migration)
      const kinds = Object.fromEntries((await scoped.query('SELECT id,kind FROM mikka_workspaces')).rows.map(row => [row.id, row.kind]))
      assert.deepEqual(kinds, {
        [alone]: 'personal', [accepted]: 'personal',
        [grown]: 'team', [inviting]: 'team', [created]: 'team', [suspended]: 'team', [regrown]: 'team',
      })
      assert.equal((await scoped.query('SELECT count(*)::int AS n FROM mikka_workspaces')).rows[0].n, 7, 'no row added or removed')
      // A later re-run (the file was renamed): 'regrown' got a personal workspace lazily, then the peer
      // left its default one. The default stays a team; the person keeps the personal one they have.
      const lazy = randomUUID()
      await scoped.query(`INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,'regrown','regrown','personal')`, [lazy])
      await scoped.query(`DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"='peer'`, [regrown])
      await scoped.query(migration)
      assert.deepEqual((await scoped.query(`SELECT id,kind FROM mikka_workspaces WHERE "userId"='regrown' ORDER BY kind`)).rows, [{ id: lazy, kind: 'personal' }, { id: regrown, kind: 'team' }])
      await assert.rejects(scoped.query(`INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,'alone','x','personal')`, [randomUUID()]), { code: '23505' }, 'one personal workspace per person')
      await assert.rejects(scoped.query(`UPDATE mikka_workspaces SET kind='shared' WHERE id=$1`, [grown]), { code: '23514' })
    } finally {
      await scoped.end()
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
    }
  })

  await t.test('a user whose first workspace came from an invite gets a personal workspace; work is charged where it happens', async () => {
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const { executionWorkspace } = await import('../lib/execution-settings')
    const owner = await seedUser(pool, 'owner'), invited = await seedUser(pool, 'invited')
    const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: invited, role: 'member' }])
    const personal = await ensurePersonalWorkspace({ id: invited, email: `${invited}@example.invalid`, name: 'invited' }, 'zh-CN')
    assert.notEqual(personal, team.id)
    const { rows: [row] } = await pool.query('SELECT "userId",kind FROM mikka_workspaces WHERE id=$1', [personal])
    assert.deepEqual(row, { userId: invited, kind: 'personal' })
    assert.deepEqual((await pool.query('SELECT "userId",role,status FROM mikka_workspace_members WHERE "workspaceId"=$1', [personal])).rows, [{ userId: invited, role: 'admin', status: 'active' }], 'only that user')
    assert.equal(await ensurePersonalWorkspace({ id: invited, email: `${invited}@example.invalid`, name: 'invited' }, 'zh-CN'), personal, 'created once')
    // Decision 2026-10-31-2225: the Coordinator's triage keeps billing the workspace it already used; nothing moves to the new personal one.
    assert.equal(await executionWorkspace(invited, null), team.id)
    const personalBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4)', [personalBot, invited, personal, 'Mine'])
    assert.equal(await executionWorkspace(invited, personalBot), personal, 'a bot in the personal workspace is charged there')
  })

  await t.test('a sign-up workspace that became a team stays a team; its owner gets a second, personal one', async () => {
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const owner = await seedUser(pool, 'grown')
    const defaultId = uuidFrom(`orvilo-default:${owner}`)
    await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug) VALUES ($1,$2,'Team',$3)`, [defaultId, owner, `ws-${defaultId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,'o','o@example.invalid','admin')`, [defaultId, owner])
    const personal = await ensurePersonalWorkspace({ id: owner, email: `${owner}@example.invalid`, name: 'grown' }, 'zh-CN')
    assert.equal(personal, uuidFrom(`mikka-personal:${owner}`))
    assert.equal((await pool.query('SELECT kind FROM mikka_workspaces WHERE id=$1', [defaultId])).rows[0].kind, 'team')
    // Concurrent first loads create exactly one.
    const racer = await seedUser(pool, 'racer')
    const ids = await Promise.all(Array.from({ length: 4 }, () => ensurePersonalWorkspace({ id: racer, email: `${racer}@example.invalid`, name: 'racer' }, 'en')))
    assert.equal(new Set(ids).size, 1)
    assert.equal(ids[0], uuidFrom(`orvilo-default:${racer}`), 'a new user keeps the sign-up id')
  })

  await t.test('no trial: a verified card funds nothing, and every unfunded workspace is refused for points', async () => {
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const { canUseMikkaPaid, hostedUsage } = await import('../lib/abuse/runtime')
    const { executionWorkspace } = await import('../lib/execution-settings')
    const owner = await seedUser(pool, 'verified'), peer = await seedUser(pool, 'peer')
    const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
    await hostedUsage.verify(team.id, 'cus_synthetic_team', `card_${randomUUID()}`)
    const personal = await ensurePersonalWorkspace({ id: owner, email: `${owner}@example.invalid`, name: 'verified' }, 'zh-CN')
    // Decision 2026-11-15-1900: no trial and no card allowance; Mikka 额度 comes from a plan or a top-up.
    await assert.rejects(canUseMikkaPaid(personal), { code: 'points_exhausted' })
    assert.equal(await executionWorkspace(owner, null), team.id)
    await assert.rejects(canUseMikkaPaid(team.id), { code: 'points_exhausted' })
    const stranger = await seedUser(pool, 'unverified')
    const theirs = await ensurePersonalWorkspace({ id: stranger, email: `${stranger}@example.invalid`, name: 'unverified' }, 'zh-CN')
    await assert.rejects(canUseMikkaPaid(theirs), { code: 'points_exhausted' })
    // A top-up funds it at once.
    await pool.query(`INSERT INTO workspace_credit_grants (id,"workspaceId",bucket,points,reason,"externalId") VALUES ($1,$2,'purchased',100,'pack',$3)`, [randomUUID(), theirs, `points-${randomUUID()}`])
    assert.equal((await canUseMikkaPaid(theirs)).purchased, 1_000_000)
  })

  await t.test('the admin has one switch over shared API keys, audited, and none in a personal workspace', async () => {
    const policy = await import('../lib/personal-policy-server')
    const { WorkspaceError } = await import('../lib/workspace-access')
    const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    assert.deepEqual(await policy.getMemberSubscriptionPolicy(member, team.id), { allowed: true, canEdit: false })
    await rejects(policy.setMemberSubscriptionPolicy({ id: member, name: 'Mia' }, team.id, false), 'workspaceAccessDenied')
    assert.deepEqual(await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Alex' }, team.id, false), { allowed: false, canEdit: true })
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Alex' }, team.id, false)
    assert.deepEqual((await pool.query(`select metadata from workspace_audit_events where "workspaceId"=$1 and metadata->>'integration'='personal_subscriptions'`, [team.id])).rows, [{ metadata: { integration: 'personal_subscriptions', capability: 'use', from: 'allow', to: 'deny' } }], 'audited once')
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const personal = await ensurePersonalWorkspace({ id: member, email: `${member}@example.invalid`, name: 'member' }, 'zh-CN')
    assert.equal((await policy.getMemberSubscriptionPolicy(member, personal)).canEdit, false)
    await rejects(policy.setMemberSubscriptionPolicy({ id: member, name: 'Mia' }, personal, false), 'validationGeneric')
  })

  await t.test('leaving a team pauses the bots there until an admin takes one over', async () => {
    const members = await import('../lib/workspace-admin/members')
    const { executionWorkspace } = await import('../lib/execution-settings')
    const admin = await seedUser(pool, 'admin'), leaver = await seedUser(pool, 'leaver')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: leaver, role: 'member' }])
    const other = await seedWorkspace(pool, leaver, [{ userId: leaver, role: 'admin' }])
    const bot = randomUUID(), elsewhere = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4),($5,$2,$6,$4)', [bot, leaver, team.id, 'Helper', elsewhere, other.id])
    assert.equal(await executionWorkspace(leaver, bot), team.id)
    await members.removeMember(admin, team.id, leaver)
    assert.ok((await pool.query('SELECT "archivedAt" FROM bots WHERE id=$1', [bot])).rows[0].archivedAt, 'their bot there is paused')
    assert.equal((await pool.query('SELECT "archivedAt" FROM bots WHERE id=$1', [elsewhere])).rows[0].archivedAt, null)
    await assert.rejects(executionWorkspace(leaver, bot), { code: 'botNotFound' }, 'a paused bot runs nothing')
    assert.deepEqual((await members.archivedBots(admin, team.id)).map(row => row.id), [bot])
    await assert.rejects(members.archivedBots(leaver, team.id), { code: 'workspaceAccessDenied' })
    await assert.rejects(members.takeOverBot(leaver, team.id, bot), { code: 'workspaceAccessDenied' })
    const takeoverAudits = async () => (await pool.query(`SELECT count(*)::int AS n FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND payload->>'action'='bot.taken_over' AND payload->>'targetId'=$2`, [team.id, bot])).rows[0].n
    const conflicting = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4)', [conflicting, admin, team.id, 'Helper'])
    await assert.rejects(members.takeOverBot(admin, team.id, bot), { code: 'botTransferNameConflict' })
    assert.equal(await takeoverAudits(), 0, 'a failed transfer rolls back its audit')
    await pool.query('DELETE FROM bots WHERE id=$1', [conflicting])
    assert.deepEqual(await members.takeOverBot(admin, team.id, bot), { bots: 1 })
    assert.deepEqual((await pool.query('SELECT "ownerId","archivedAt" FROM bots WHERE id=$1', [bot])).rows[0], { ownerId: admin, archivedAt: null }, 'it now runs on the admin\'s own resources')
    assert.equal(await executionWorkspace(admin, bot), team.id)
    await assert.rejects(members.takeOverBot(admin, team.id, bot), { code: 'botNotFound' }, 'only a paused bot can be taken over')
    assert.equal(await takeoverAudits(), 1, 'one audit for the completed transfer, including after a retry')
  })

  await t.test('the archived bot directory and takeover keep the administrator transaction through the APP read and commit', async t => {
    const { archivedBots, takeOverBot } = await import('../lib/workspace-admin/members')
    const { withDatabaseClient } = await import('../lib/db')
    const { workspaceTransactionKey } = await import('../lib/workspace-db')
    const admin = await seedUser(pool, 'archive-admin')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const bot = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name,"archivedAt") VALUES ($1,$2,$3,$4,now())', [bot, admin, team.id, 'Archived'])
    const client = await appPool.connect()
    const query = client.query
    const reads: Array<object | null> = []
    const commits: Array<object | null> = []
    const observed = t.mock.method(client, 'query', (...args: unknown[]) => {
      const statement = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text
      if (/from "bots"/i.test(statement)) reads.push(workspaceTransactionKey())
      if (/^commit$/i.test(statement)) commits.push(workspaceTransactionKey())
      return Reflect.apply(query, client, args)
    })
    try {
      assert.deepEqual((await withDatabaseClient(client, () => archivedBots(admin, team.id))).map(row => row.id), [bot])
      assert.equal(reads.length, 1)
      assert.ok(reads[0], 'the directory reads under its active Workspace transaction')
      reads.length = 0
      assert.deepEqual(await withDatabaseClient(client, () => takeOverBot(admin, team.id, bot)), { bots: 1 })
      assert.ok(reads[0], 'the takeover reads the archived bot under the administrator lock')
      assert.equal(commits.length, 1)
      assert.equal(commits[0], reads[0], 'the same Workspace transaction stays active through APP commit')
    } finally {
      observed.mock.restore()
      client.release()
    }
  })

  await t.test('withdrawing a credential stops the runs using it at once; credential access then refuses them', async () => {
    const policy = await import('../lib/personal-policy-server')
    const members = await import('../lib/workspace-admin/members')
    const { stopRunsUsingSubscriptions } = await import('../lib/personal-policy')
    const owner = await seedUser(pool, 'sharer'), peer = await seedUser(pool, 'peer'), admin = await seedUser(pool, 'admin')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: peer, role: 'member' }])
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'claude','connected',$4,$5,'synthetic-subject')`,
      [connection, owner, team.id, `synthetic-${randomUUID()}`, 'b'.repeat(64)])
    // A run on the device of whoever's bot it is, holding a short-lived credential from the owner's connection.
    const runOn = async (runner: string) => {
      const agent = await seedAgent(pool, runner, 'claude_code'), binding = randomUUID()
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'claude_code_cli','synthetic-model')`, [binding, owner, team.id, agent, connection])
      const run = await seedRun(pool, { userId: runner, agentId: agent, status: 'running' })
      await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [run])
      await pool.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [run, binding])
      return run
    }
    // The predicate every credential access and renewal applies (subscription-access-snapshot, subscription-service).
    const usable = async (run: string) => Boolean((await pool.query(`SELECT 1 FROM agent_runs WHERE id=$1 AND status IN ('preparing','running','paused','waiting_input') AND "leaseExpiresAt">now() AND "stopRequestedAt" IS NULL`, [run])).rowCount)
    // A subscription serves its owner only (decision 2026-11-17): only the owner's own run holds it.
    const ownRun = await runOn(owner)
    assert.equal(await usable(ownRun), true)
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Admin' }, team.id, false)
    assert.equal(await usable(ownRun), true, 'the admin switch never stops the owner\'s own run')
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Admin' }, team.id, true)
    const beforeLeaving = await runOn(owner)
    await members.removeMember(admin, team.id, owner)
    assert.equal(await usable(beforeLeaving), false, 'leaving stops what ran on their subscription')
    const afterDisconnect = await runOn(owner)
    assert.equal(await stopRunsUsingSubscriptions(pool, { ownerId: owner, connectionId: connection }), 1, '断开连接 stops runs on that connection')
    assert.equal(await usable(afterDisconnect), false)
    await assert.rejects(stopRunsUsingSubscriptions(pool, { ownerId: owner }), /workspace or a connection/, 'never everything at once')
  })

  await t.test('every model call checks the subscription is the bot owner\'s own', async () => {
    const { authorizeSubscriptionUse } = await import('../lib/subscription-runtime')
    const members = await import('../lib/workspace-admin/members')
    const admin = await seedUser(pool, 'admin'), owner = await seedUser(pool, 'owner'), peer = await seedUser(pool, 'peer')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: peer, role: 'member' }])
    const ownBot = randomUUID(), peerBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [ownBot, owner, team.id, 'Bot', peerBot, peer])
    await authorizeSubscriptionUse(owner, team.id, ownBot)
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' }, 'a teammate\'s bot never uses it')
    // The owner leaves: even their own bot there is refused.
    await members.removeMember(admin, team.id, owner)
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, ownBot))
  })

  await t.test('a subscription connected in the personal workspace answers its owner\'s chats in a team; never a teammate\'s', async () => {
    const { authorizeSubscriptionUse } = await import('../lib/subscription-runtime')
    const { SubscriptionService } = await import('../lib/subscription-service')
    const { SubscriptionRepository } = await import('../lib/subscription-repository')
    const { ExecutionSettings } = await import('../lib/execution-settings')
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const admin = await seedUser(pool, 'admin'), owner = await seedUser(pool, 'owner'), peer = await seedUser(pool, 'peer')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: peer, role: 'member' }])
    const personal = await ensurePersonalWorkspace({ id: owner, email: `${owner}@example.invalid`, name: 'owner' }, 'zh-CN')
    const connection = randomUUID()
    const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: 0.2, resetsAt: null }] }
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota) VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'synthetic-subject',$6)`,
      [connection, owner, personal, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify(quota)])
    const ownBot = randomUUID(), peerBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [ownBot, owner, team.id, 'Bot', peerBot, peer])
    const bind = async (consumerId: string) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'claude_cpa','claude-test-model')`, [id, owner, team.id, consumerId, connection])
      return id
    }
    const ownBinding = await bind(ownBot), peerBinding = await bind(peerBot)
    // The runtime's own checks, with no worker: the quota above is fresh, so nothing is probed.
    const service = new SubscriptionService(new SubscriptionRepository(appPool), () => { throw new Error('no probe expected') },
      { ready: () => true, oauth: { codex: false, claude: false }, nativeIsolation: 'none' }, undefined, authorizeSubscriptionUse)
    const use = (consumerId: string, bindingId: string) => ({ ownerId: owner, workspaceId: team.id, consumerId, bindingId, execution: 'model' as const })
    const allowed = await service.check(use(ownBot, ownBinding))
    assert.equal(allowed.connection.workspaceId, personal, 'the owner\'s own bot in the team uses the personal subscription')
    await assert.rejects(service.check(use(peerBot, peerBinding)), { code: 'account_unavailable' }, 'a teammate\'s bot never uses it')
    await service.check(use(ownBot, ownBinding))

    // Without a PostHog project, shipped subscription routes are available.
    // The real connection state still fences both the menu and saved choices.
    const settings = new ExecutionSettings(appPool)
    const savedRoutes = process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES
    try {
      delete process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES
      assert.deepEqual((await settings.chatModels({ ownerId: owner, workspaceId: team.id })).map(row => row.modelId), ['claude-test-model'])
      assert.equal((await settings.chatBinding({ ownerId: owner, workspaceId: team.id }, ownBinding))?.connectionId, connection)
      await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [connection])
      assert.deepEqual(await settings.chatModels({ ownerId: owner, workspaceId: team.id }), [])
      assert.equal(await settings.chatBinding({ ownerId: owner, workspaceId: team.id }, ownBinding), undefined)
      await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [connection])
      assert.deepEqual((await settings.chatModels({ ownerId: owner, workspaceId: team.id })).map(row => row.modelId), ['claude-test-model'])
    } finally {
      if (savedRoutes === undefined) delete process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES
      else process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = savedRoutes
    }
  })

  await t.test('community bot chats use only their available chosen credential without a server model or Decision key', async t => {
    const names = ['MIKKA_EDITION', 'MIKKA_DEFAULT_MODEL_BASE_URL', 'MIKKA_DEFAULT_MODEL_API_KEY', 'MIKKA_DEFAULT_MODEL_ID', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'ZEROCAT_API_KEY', 'ZEROCAT_BASE_URL', 'DECISIONS_API_KEY', 'MIKKA_MVP_E2E', 'MIKKA_BYOS_VALIDATED_MODEL_ROUTES']
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
    t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name] } })
    for (const name of names) delete process.env[name]
    process.env.MIKKA_EDITION = 'community'
    process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
    const { coordinatorEnabled, triageInbox } = await import('../lib/coordinator/wake')
    const { defaultModelConfigured } = await import('../lib/default-model-config')
    const { defaultModelAvailable } = await import('../lib/default-model')
    const { ExecutionSettings } = await import('../lib/execution-settings')
    const { HOSTED_CHOICE } = await import('../lib/bot-model-menu-view')
    const { seedBot } = await import('./support/workspace-admin-db')
    const owner = await seedUser(pool, 'community-chat'), other = await seedUser(pool, 'community-other')
    const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const bot = await seedBot(pool, workspace.id, owner), settings = new ExecutionSettings(appPool)
    assert.equal(defaultModelConfigured(), false)
    assert.equal(await defaultModelAvailable(owner), false)
    assert.equal(await coordinatorEnabled(owner, bot), false, 'a bot with no credential remains disabled')
    const connection = randomUUID(), binding = randomUUID()
    const quota = (used: number, age = 0) => ({ vendor: 'claude_code', source: 'official', status: 'ok', plan: null,
      observedAt: new Date(Date.now() - age).toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: '2099-01-01T00:00:00.000Z' }] })
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota)
      VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'synthetic-readiness-subject',$6)`,
      [connection, owner, workspace.id, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify(quota(0.2))])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,$4,$5,1,'claude_cpa','claude-readiness-fixture')`, [binding, owner, workspace.id, bot, connection])
    await settings.setBotModel({ ownerId: owner, workspaceId: workspace.id }, bot, binding)
    const saved = (await pool.query('SELECT * FROM bot_model_choices WHERE "ownerId"=$1', [owner])).rows
    assert.equal(await coordinatorEnabled(owner, bot), true)
    assert.deepEqual((await pool.query('SELECT * FROM bot_model_choices WHERE "ownerId"=$1', [owner])).rows, saved, 'checking readiness never changes the saved choice')
    assert.equal(await coordinatorEnabled(other, bot), false, 'another owner cannot enable this bot')

    // No Decision provider is configured. Actual user input still reaches the
    // attention tier; no classification result or provider call is invented.
    const eventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload)
      VALUES ($1,$2,$3,'user_message',$4,$5)`, [eventId, owner, bot, `readiness:${eventId}`, JSON.stringify({ text: 'Synthetic readiness input.' })])
    await triageInbox(owner, bot)
    assert.equal((await pool.query('SELECT tier FROM coordinator_events WHERE id=$1', [eventId])).rows[0].tier, 'attention')

    for (const state of ['paused=true', "state='disconnected'", 'epoch=2']) {
      await pool.query(`UPDATE byos_connections SET ${state} WHERE id=$1`, [connection])
      assert.equal(await coordinatorEnabled(owner, bot), false, 'paused, disconnected and obsolete bindings never enable chat')
      await pool.query(`UPDATE byos_connections SET paused=false,state='connected',epoch=1 WHERE id=$1`, [connection])
    }
    // This native route is valid in the stored binding CHECK, but is excluded
    // by executionModelOptions from the bot-chat catalogue.
    await pool.query(`UPDATE byos_bindings SET route='claude_code_cli' WHERE "connectionId"=$1`, [connection])
    assert.equal(await coordinatorEnabled(owner, bot), false, 'a native-only binding cannot enable a bot chat')
    await pool.query(`UPDATE byos_bindings SET route='claude_cpa' WHERE "connectionId"=$1`, [connection])
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [connection, JSON.stringify(quota(1))])
    assert.equal(await coordinatorEnabled(owner, bot), false, 'a known exhausted selected model remains unavailable')
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [connection, JSON.stringify(quota(0.2, 120_000))])
    assert.equal(await coordinatorEnabled(owner, bot), true, 'a stale official allowance can queue its normal authoritative execution check')
    // 「Mikka 默认」 is gone (decision 2026-11-15-1900), and with no server model Mikka 额度 offers nothing here.
    await assert.rejects(settings.setBotModel({ ownerId: owner, workspaceId: workspace.id }, bot, HOSTED_CHOICE), { code: 'executionModelUnknown' })
    await assert.rejects(settings.setBotModel({ ownerId: owner, workspaceId: workspace.id }, bot, 'credits:deepseek/deepseek-v4.1-flash'), { code: 'executionModelUnknown' })
    assert.equal(await coordinatorEnabled(owner, bot), true, 'the chosen subscription stays chosen')
    await settings.setBotModel({ ownerId: owner, workspaceId: workspace.id }, bot, binding)
    await pool.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [bot])
    assert.equal(await coordinatorEnabled(owner, bot), false, 'an archived bot remains disabled')
    await pool.query('UPDATE bots SET "archivedAt"=NULL WHERE id=$1', [bot])
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    assert.equal(await coordinatorEnabled(owner, bot), false, 'a suspended member cannot enable this bot')
  })

  await t.test('由我的卡支付这个团队: one member\'s card per team; leaving releases it with a 7-day grace that admins see', async () => {
    const { designateOwnCard, paymentDesignation, PAYMENT_GRACE_DAYS } = await import('../lib/payment-designation')
    const { hostedUsage } = await import('../lib/abuse/runtime')
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const members = await import('../lib/workspace-admin/members')
    const { WorkspaceError } = await import('../lib/workspace-access')
    const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
    const admin = await seedUser(pool, 'admin'), payer = await seedUser(pool, 'payer'), other = await seedUser(pool, 'other')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: payer, role: 'member' }, { userId: other, role: 'member' }])
    const own = await ensurePersonalWorkspace({ id: payer, email: `${payer}@example.invalid`, name: 'payer' }, 'zh-CN')
    assert.equal((await paymentDesignation(payer, team.id)).canDesignate, false, 'no card yet')
    await rejects(designateOwnCard({ id: payer, name: 'Pat' }, team.id), 'validationGeneric')
    await hostedUsage.verify(own, `cus_${randomUUID()}`, `card_${randomUUID()}`)
    const otherOwn = await ensurePersonalWorkspace({ id: other, email: `${other}@example.invalid`, name: 'other' }, 'zh-CN')
    await hostedUsage.verify(otherOwn, `cus_${randomUUID()}`, `card_${randomUUID()}`)
    assert.deepEqual(await designateOwnCard({ id: payer, name: 'Pat' }, team.id), { mine: true, payerName: null, graceUntil: null, canDesignate: true, admin: false })
    await rejects(designateOwnCard({ id: other, name: 'Oli' }, team.id), 'workspacePaymentTaken')
    await rejects(designateOwnCard({ id: payer, name: 'Pat' }, own), 'validationGeneric')
    assert.equal((await paymentDesignation(admin, team.id)).payerName, 'payer', 'admins see whose card pays')
    // The payer leaves: the card keeps paying through the grace period, and admins see until when.
    await members.removeMember(admin, team.id, payer)
    const view = await paymentDesignation(admin, team.id)
    assert.equal(view.payerName, 'payer')
    const days = (Date.parse(view.graceUntil!) - Date.now()) / 86_400_000
    assert.ok(days > PAYMENT_GRACE_DAYS - 0.1 && days <= PAYMENT_GRACE_DAYS, `grace of ${PAYMENT_GRACE_DAYS} days`)
    assert.deepEqual((await pool.query(`select metadata from workspace_audit_events where "workspaceId"=$1 and action='billing.payment_method_changed' order by "createdAt"`, [team.id])).rows.map(row => row.metadata), [{ change: 'designated' }, { change: 'released', graceDays: PAYMENT_GRACE_DAYS }])
    // Another member can take over payment once it is released.
    assert.equal((await designateOwnCard({ id: other, name: 'Oli' }, team.id)).mine, true)
  })
})
