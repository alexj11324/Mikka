// Personal workspaces (decision 2026-10-31-2130) against a real PostgreSQL:
// the kind backfill on existing data, invited sign-ups, and who pays for work
// with no workspace of its own.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace, useUpFreeMessages } from './support/workspace-admin-db'

const uuidFrom = (seed: string) => {
  const hash = createHash('sha256').update(seed).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

test('personal workspaces', { skip: !dbUrl }, async t => {
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

  await t.test('a card verified on a workspace that became a team keeps working: the fresh personal workspace is verified too', async () => {
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const { canUseMikkaPaid, hostedUsage } = await import('../lib/abuse/runtime')
    const { executionWorkspace } = await import('../lib/execution-settings')
    const owner = await seedUser(pool, 'verified'), peer = await seedUser(pool, 'peer')
    const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
    await hostedUsage.verify(team.id, 'cus_synthetic_team', `card_${randomUUID()}`)
    const personal = await ensurePersonalWorkspace({ id: owner, email: `${owner}@example.invalid`, name: 'verified' }, 'zh-CN')
    // Decision 2026-10-31-2225: verification is per person, and a new personal workspace starts like a new sign-up.
    const balance = await canUseMikkaPaid(personal)
    assert.equal(balance.verified, true)
    assert.ok(balance.free > 0, 'the free allowance')
    // Triage keeps running where it ran before: the team, with its verified card.
    assert.equal(await executionWorkspace(owner, null), team.id)
    assert.equal((await canUseMikkaPaid(team.id)).verified, true)
    // Someone who never verified is told so, never silently stopped.
    const stranger = await seedUser(pool, 'unverified')
    const theirs = await ensurePersonalWorkspace({ id: stranger, email: `${stranger}@example.invalid`, name: 'unverified' }, 'zh-CN')
    // A new sign-up's first messages are free (TRIAL_MESSAGES); past them, a card.
    assert.equal(((await canUseMikkaPaid(theirs)) as { trialLeft?: number }).trialLeft, 20)
    await useUpFreeMessages(pool, theirs, stranger)
    await assert.rejects(canUseMikkaPaid(theirs), { code: 'verification_required' })
    // A peer's verification on a team they do not own does not verify their personal workspace.
    const peerPersonal = await ensurePersonalWorkspace({ id: peer, email: `${peer}@example.invalid`, name: 'peer' }, 'zh-CN')
    await useUpFreeMessages(pool, peerPersonal, peer)
    await assert.rejects(canUseMikkaPaid(peerPersonal), { code: 'verification_required' })
  })

  await t.test('sharing is the member\'s own opt-in; the admin has one switch, audited, and none in a personal workspace', async () => {
    const policy = await import('../lib/personal-policy-server')
    const { WorkspaceError } = await import('../lib/workspace-access')
    const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
    const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    assert.deepEqual(await policy.getSubscriptionShare(member, team.id), { personal: false, shared: false, allowOthers: false, allowed: true, available: [], own: [] }, 'not shared until the member chooses')
    assert.deepEqual(await policy.setOwnSubscriptionShare(member, team.id, { shared: true }), { personal: false, shared: true, allowOthers: false, allowed: true, available: [], own: [] })
    assert.deepEqual(await policy.getSubscriptionShare(admin, team.id), { personal: false, shared: false, allowOthers: false, allowed: true, available: [], own: [] }, 'one member sharing shares nothing of anyone else')
    assert.deepEqual(await policy.getMemberSubscriptionPolicy(member, team.id), { allowed: true, canEdit: false })
    await rejects(policy.setMemberSubscriptionPolicy({ id: member, name: 'Mia' }, team.id, false), 'workspaceAccessDenied')
    assert.deepEqual(await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Alex' }, team.id, false), { allowed: false, canEdit: true })
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Alex' }, team.id, false)
    assert.deepEqual((await pool.query(`select metadata from workspace_audit_events where "workspaceId"=$1 and metadata->>'integration'='personal_subscriptions'`, [team.id])).rows, [{ metadata: { integration: 'personal_subscriptions', capability: 'use', from: 'allow', to: 'deny' } }], 'audited once')
    assert.deepEqual(await policy.getSubscriptionShare(member, team.id), { personal: false, shared: true, allowOthers: false, allowed: false, available: [], own: [] })
    await policy.setOwnSubscriptionShare(admin, team.id, { shared: true })
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Alex' }, team.id, true)
    // 分享给团队成员: the admin sees the member's subscription is available, never the credential.
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'claude','connected',$5,$4,'synthetic-subject')`, [randomUUID(), member, team.id, 'a'.repeat(64), `synthetic-${randomUUID()}`])
    await rejects(policy.setOwnSubscriptionShare(member, team.id, { shared: true, allowOthers: true }), 'subscriptionPersonalOnly')
    assert.deepEqual((await policy.getSubscriptionShare(admin, team.id)).available, [])
    assert.deepEqual((await policy.setOwnSubscriptionShare(member, team.id, { shared: true, allowOthers: false })).allowOthers, false)
    assert.deepEqual((await policy.getSubscriptionShare(admin, team.id)).available, [])
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const personal = await ensurePersonalWorkspace({ id: member, email: `${member}@example.invalid`, name: 'member' }, 'zh-CN')
    assert.deepEqual(await policy.getSubscriptionShare(member, personal), { personal: true, shared: true, allowOthers: false, allowed: true, available: [], own: [] })
    assert.equal((await pool.query('select count(*)::int as n from workspace_subscription_shares where "ownerId"=$1 and "workspaceId"=$2', [member, personal])).rows[0].n, 1, 'a personal workspace uses its owner\'s subscriptions without a share step')
    assert.equal((await policy.getMemberSubscriptionPolicy(member, personal)).canEdit, false)
    await rejects(policy.setMemberSubscriptionPolicy({ id: member, name: 'Mia' }, personal, false), 'validationGeneric')
  })

  await t.test('leaving a team removes the subscription share and pauses the bots there until an admin takes one over', async () => {
    const members = await import('../lib/workspace-admin/members')
    const { setSubscriptionShare } = await import('../lib/personal-policy')
    const subscriptionShared = async (_: unknown, ownerId: string, workspaceId: string) => Boolean((await pool.query('SELECT 1 FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])).rowCount)
    const { executionWorkspace } = await import('../lib/execution-settings')
    const admin = await seedUser(pool, 'admin'), leaver = await seedUser(pool, 'leaver')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: leaver, role: 'member' }])
    const other = await seedWorkspace(pool, leaver, [{ userId: leaver, role: 'admin' }])
    const bot = randomUUID(), elsewhere = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4),($5,$2,$6,$4)', [bot, leaver, team.id, 'Helper', elsewhere, other.id])
    await setSubscriptionShare(pool, leaver, team.id, true)
    await setSubscriptionShare(pool, leaver, other.id, true)
    assert.equal(await executionWorkspace(leaver, bot), team.id)
    await members.removeMember(admin, team.id, leaver)
    assert.equal(await subscriptionShared(pool, leaver, team.id), false, 'the share leaves with them, at once')
    assert.equal(await subscriptionShared(pool, leaver, other.id), true, 'their other workspaces are untouched')
    assert.ok((await pool.query('SELECT "archivedAt" FROM bots WHERE id=$1', [bot])).rows[0].archivedAt, 'their bot there is paused')
    assert.equal((await pool.query('SELECT "archivedAt" FROM bots WHERE id=$1', [elsewhere])).rows[0].archivedAt, null)
    await assert.rejects(executionWorkspace(leaver, bot), { code: 'botNotFound' }, 'a paused bot runs nothing')
    assert.deepEqual((await members.archivedBots(admin, team.id)).map(row => row.id), [bot])
    await assert.rejects(members.archivedBots(leaver, team.id))
    assert.deepEqual(await members.takeOverBot(admin, team.id, bot), { bots: 1 })
    assert.equal(Number((await pool.query(`SELECT count(*) FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND payload->>'action'='bot.taken_over' AND payload->>'targetId'=$2`, [team.id, bot])).rows[0].count), 1, '接管 is in the activity log')
    assert.deepEqual((await pool.query('SELECT "ownerId","archivedAt" FROM bots WHERE id=$1', [bot])).rows[0], { ownerId: admin, archivedAt: null }, 'it now runs on the admin\'s own resources')
    assert.equal(await executionWorkspace(admin, bot), team.id)
    await assert.rejects(members.takeOverBot(admin, team.id, bot), (error: unknown) => (error as { code?: string }).code === 'botNotFound', 'only a paused bot can be taken over')
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
    await assert.rejects(policy.setOwnSubscriptionShare(owner, team.id, { shared: true, allowOthers: true }), { code: 'subscriptionPersonalOnly' })
    const peersRun = await runOn(peer), ownRun = await runOn(owner)
    assert.equal(await usable(peersRun), true)
    await policy.setOwnSubscriptionShare(owner, team.id, { shared: true, allowOthers: false })
    assert.equal(await usable(peersRun), false, '分享给团队成员 off: the other member\'s run stops and its credential is refused')
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [peersRun])).rows[0].stopRequestedAt)
    assert.equal(await usable(ownRun), true, 'the owner\'s own run keeps going')
    // Decision 2026-11-01-2240: un-sharing and the admin switch govern other members' use only.
    const peersSecond = await runOn(peer)
    await pool.query(`UPDATE agent_runs SET status='paused' WHERE id=$1`, [peersSecond])
    await policy.setOwnSubscriptionShare(owner, team.id, { shared: false })
    assert.equal(await usable(ownRun), true, 'un-sharing never stops the owner\'s own run')
    assert.equal(await usable(peersSecond), false, 'un-sharing stops a paused run before it can resume on the withdrawn credential')
    await assert.rejects(policy.setOwnSubscriptionShare(owner, team.id, { shared: true, allowOthers: true }), { code: 'subscriptionPersonalOnly' })
    const peersThird = await runOn(peer)
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Admin' }, team.id, false)
    assert.equal(await usable(peersThird), false, 'the admin switch off stops another member\'s run on it')
    assert.equal(await usable(ownRun), true, 'the admin switch off never stops the owner\'s own run')
    await policy.setMemberSubscriptionPolicy({ id: admin, name: 'Admin' }, team.id, true)
    const beforeLeaving = await runOn(peer)
    await members.removeMember(admin, team.id, owner)
    assert.equal(await usable(beforeLeaving), false, 'leaving stops what ran on their subscription')
    const afterDisconnect = await runOn(owner)
    assert.equal(await stopRunsUsingSubscriptions(pool, { ownerId: owner, connectionId: connection }), 1, '断开连接 stops runs on that connection')
    assert.equal(await usable(afterDisconnect), false)
    await assert.rejects(stopRunsUsingSubscriptions(pool, { ownerId: owner }), /workspace or a connection/, 'never everything at once')
  })

  await t.test("every model call rejects another member's personal subscription before and after revocation", async () => {
    const { authorizeSubscriptionUse } = await import('../lib/subscription-runtime')
    const { setSubscriptionShare } = await import('../lib/personal-policy')
    const members = await import('../lib/workspace-admin/members')
    const admin = await seedUser(pool, 'admin'), owner = await seedUser(pool, 'owner'), peer = await seedUser(pool, 'peer')
    const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: peer, role: 'member' }])
    const ownBot = randomUUID(), peerBot = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [ownBot, owner, team.id, 'Bot', peerBot, peer])
    // Decision 2026-11-01-2240: the owner's own bot needs no share step.
    await authorizeSubscriptionUse(owner, team.id, ownBot)
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' }, 'not shared: own bots only')
    await setSubscriptionShare(pool, owner, team.id, true)
    await authorizeSubscriptionUse(owner, team.id, ownBot)
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' }, 'shared without 分享给团队成员: own bots only')
    await assert.rejects(setSubscriptionShare(pool, owner, team.id, true, true), { code: 'subscriptionPersonalOnly' })
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' })
    await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [team.id])
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' }, 'the admin block stops the other member\'s bot')
    await authorizeSubscriptionUse(owner, team.id, ownBot)
    await pool.query('DELETE FROM workspace_personal_policies WHERE "workspaceId"=$1', [team.id])
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot), { code: 'account_unavailable' })
    // The owner leaves mid-flight: the peer's next model call is refused, no fallback.
    await members.removeMember(admin, team.id, owner)
    await assert.rejects(authorizeSubscriptionUse(owner, team.id, peerBot))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [owner, team.id])).rows[0].n, 0)
  })

  await t.test('a subscription connected in the personal workspace answers its owner\'s chats in a team; a teammate\'s only once shared', async () => {
    const { authorizeSubscriptionUse } = await import('../lib/subscription-runtime')
    const { setSubscriptionShare } = await import('../lib/personal-policy')
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
    await assert.rejects(service.check(use(peerBot, peerBinding)), { code: 'account_unavailable' }, 'a teammate\'s bot: not shared')
    await assert.rejects(setSubscriptionShare(pool, owner, team.id, true, true), { code: 'subscriptionPersonalOnly' })
    await assert.rejects(service.check(use(peerBot, peerBinding)), { code: 'account_unavailable' })
    await setSubscriptionShare(pool, owner, team.id, false)
    await assert.rejects(service.check(use(peerBot, peerBinding)), { code: 'account_unavailable' }, 'un-sharing stops it at once')
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
    await settings.setBotModel({ ownerId: owner, workspaceId: workspace.id }, bot, HOSTED_CHOICE)
    assert.equal(await coordinatorEnabled(owner, bot), false, 'explicit Mikka default does not silently spend an available subscription')
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
