import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { liveChannelId } from '../live/scope'
import { GatewayHub, type GatewayPeer } from '../builtin-gateway/hub'
import { PostgresGatewayBus } from '../builtin-gateway/postgres'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
  if (process.env.ORVILO_DATABASE_URL) assert.equal(process.env.ORVILO_DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Enterprise live authority requires the isolated E2E database')

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('live authority fixture timed out')), 5_000) })])
  } finally { clearTimeout(timer) }
}
function peer() {
  const messages: string[] = [], closed = Promise.withResolvers<void>()
  const value: GatewayPeer = { id: randomUUID(), send(data) { messages.push(data) }, close() { closed.resolve() } }
  return { value, messages, closed: closed.promise }
}

test('PG: Enterprise live authority fences existing capabilities, old tickets and concurrent sends with APP/WS pools of one', { skip: !target, timeout: 120_000 }, async t => {
  const keys = ['MIKKA_EDITION', 'DEVICE_GATEWAY_URL', 'DEVICE_GATEWAY_PUSH_SECRET'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousMain = globals.mikkaPool, previousWorkspace = globals.workspacePool
  const app = globals.mikkaPool = new Pool({ connectionString: target, max: 1 })
  const workspace = globals.workspacePool = new Pool({ connectionString: target, max: 1 })
  const setup = new Pool({ connectionString: target, max: 3 })
  process.env.MIKKA_EDITION = 'cloud'
  const secret = 'isolated-enterprise-live-control-fixture'
  let acknowledge = true
  const controls: string[] = []
  // This is only the network delivery boundary. ACL, SSO, SCIM, session
  // checks and locks below all use the real production code and PostgreSQL.
  // The matching control/DO/replay contract has a real workerd runtime test.
  const gateway = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const control = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    assert.deepEqual(control, { type: 'live_revoked' })
    assert.match(request.url!, /^\/v1\/live\/[a-f0-9]{64}\/push$/)
    controls.push(request.url!)
    response.writeHead(acknowledge ? 200 : 400, { 'content-type': 'application/json' })
    response.end(JSON.stringify(acknowledge ? { revoked: true } : { unsupported: true }))
  })
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
  const address = gateway.address()
  assert.ok(address && typeof address !== 'string')
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  const config = { url: process.env.DEVICE_GATEWAY_URL, secret, mode: 'worker' as const }
  const owner = { id: randomUUID(), name: 'Live Org owner', email: `${randomUUID()}@live-fixture.example.invalid` }
  const member = { id: randomUUID(), name: 'Live Org member', email: `${randomUUID()}@live-fixture.example.invalid` }
  const workspaceId = randomUUID(), personal = randomUUID()
  const ownerSession = randomUUID(), ordinarySession = randomUUID(), assuredSession = randomUUID(), racingSession = randomUUID()
  const providerId = `enterprise-live-${randomBytes(8).toString('hex')}`
  const connectionId = randomUUID(), directoryId = randomUUID()
  let organizationId: string | undefined
  const buses: PostgresGatewayBus[] = [], hubs: GatewayHub[] = []
  t.after(async () => {
    for (const hub of hubs) hub.stop()
    await Promise.all(buses.map(bus => bus.stop()))
    gateway.closeAllConnections()
    await new Promise<void>(resolve => gateway.close(() => resolve()))
    if (organizationId) {
      await setup.query('delete from enterprise_scim_outbox where "organizationId"=$1', [organizationId])
      await setup.query('delete from enterprise_revocation where "organizationId"=$1', [organizationId])
      await setup.query('delete from enterprise_identity where "providerId"=$1', [providerId])
      await setup.query('delete from enterprise_scim_user where "organizationId"=$1', [organizationId])
      await setup.query('delete from enterprise_scim_connection where "organizationId"=$1', [organizationId])
      await setup.query('delete from enterprise_sso_provider where "providerId"=$1', [providerId])
      await setup.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
      await setup.query('delete from enterprise_audit_outbox where "organizationId"=$1', [organizationId])
      await setup.query('delete from mikka_organizations where id=$1', [organizationId])
    }
    await setup.query('delete from mikka_governance_member_outbox where "workspaceId"=any($1::uuid[])', [[workspaceId, personal]])
    await setup.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])', [[workspaceId, personal]])
    await setup.query('delete from mikka_workspaces where id=any($1::uuid[])', [[workspaceId, personal]])
    await setup.query('delete from "user" where id=any($1::text[])', [[owner.id, member.id]])
    // The production retention rule deliberately retains failed controls; only
    // these disposable, uniquely owned fixture rows are removed here.
    await setup.query('delete from enterprise_live_capabilities where "workspaceId"=any($1::uuid[])', [[workspaceId, personal]])
    await Promise.all([app.end(), workspace.end(), setup.end()])
    if (previousMain) globals.mikkaPool = previousMain; else delete globals.mikkaPool
    if (previousWorkspace) globals.workspacePool = previousWorkspace; else delete globals.workspacePool
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
  })
  const live = await import('./live-authority')
  const store = await import('./live-store')
  const { pool: appPool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const { withTaskWorkspace } = await import('../task-workspace')
  const { writeTransaction } = await import('../operations/write-transaction')
  const { enterpriseWorkspaceAllowed } = await import('./access')
  const { enterprisePrincipal } = await import('./principal')
  const org = await import('../governance/organizations')
  const { manageIdentity } = await import('./management')
  const { ScimStore, identityTokenHash } = await import('./scim-store')
  assert.equal(appPool.options.max, 1)
  assert.equal(workspacePool.options.max, 1)
  for (const user of [owner, member]) await setup.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [user.id, user.name, user.email])
  for (const [id, userId] of [[ownerSession, owner.id], [ordinarySession, member.id], [assuredSession, member.id], [racingSession, member.id]]) {
    await setup.query('insert into session (id,"userId",token,"expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval \'1 hour\',now(),now())', [id, userId, randomUUID()])
  }
  await setup.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Live fixture\',\'team\'),($3,$4,\'Personal fixture\',\'personal\')', [workspaceId, owner.id, personal, member.id])
  for (const [id, user, role] of [[workspaceId, owner, 'admin'], [workspaceId, member, 'member'], [personal, member, 'admin']] as const) {
    await setup.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)', [id, user.id, user.name, user.email, role])
  }
  const scope = { ownerId: member.id, workspaceId }
  const ownerScope = { ownerId: owner.id, workspaceId }
  const personalScope = { ownerId: member.id, workspaceId: personal }
  const channel = async (sessionId: string, targetScope = scope) => {
    const result = await live.workspaceLiveTicket(targetScope, sessionId, config)
    assert.equal(result.status, 'allowed')
    assert.ok(result.status === 'allowed')
    const match = /\/v1\/live\/([a-f0-9]{64})\/socket$/.exec(new URL(result.ticket.url).pathname)
    assert.ok(match)
    return match[1]
  }
  organizationId = (await org.createOrganization(owner, { name: 'Live authority Org' })).id
  await org.addOrganizationMember(organizationId, owner.id, { userId: member.id })
  const orgId = organizationId
  await setup.query('update mikka_organization_entitlements set plan=\'enterprise\',source=\'cloud\',"seatLimit"=5 where "organizationId"=$1', [orgId])
  const policy = (enforceSso: boolean) => manageIdentity(orgId, { user: owner, session: { id: ownerSession } },
    { action: 'policy', enforceSso, allowMachineCredentials: false }, 'https://live-fixture.example.invalid')
  const emitted = async (targetScope = scope) => {
    const channels: string[] = []
    await bounded(live.sendEnterpriseLiveInvalidations(targetScope, async value => { channels.push(value) }))
    return channels
  }
  async function assertBlocked(pid: number) {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const { rows: [state] } = await setup.query<{ blocked: boolean }>('select cardinality(pg_blocking_pids($1))>0 as blocked', [pid])
      if (state.blocked) return
      await delay(10)
    }
    assert.fail('the real PG backend never waited for the authority lock')
  }

  await t.test('Inbox invalidations use the live membership gate and skip the database when delivery is disabled', async t => {
    const { inboxChanged } = await import('../inbox/runtime')
    const { workspacePool } = await import('../workspace-db')
    const direct = t.mock.method(workspacePool, 'query')
    const sent: string[] = []
    t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
      sent.push(String(input))
      assert.deepEqual(JSON.parse(String(init?.body)), [{ kind: 'issue_list', id: personal }, { kind: 'pending_actions', id: personal }])
      return new Response(null, { status: 200 })
    })
    const url = process.env.DEVICE_GATEWAY_URL
    try {
      delete process.env.DEVICE_GATEWAY_URL
      await inboxChanged(member.id, personal)
      assert.equal(direct.mock.callCount(), 0, 'disabled delivery has no preliminary membership query')
      assert.deepEqual(sent, [])
    } finally {
      process.env.DEVICE_GATEWAY_URL = url
    }
    await inboxChanged(owner.id, personal)
    assert.deepEqual(sent, [], 'a foreign personal workspace cannot emit an invalidation')
    await inboxChanged(member.id, personal)
    assert.deepEqual(sent, [`${url}/v1/live/${liveChannelId(personalScope)}/push`])
    assert.equal(direct.mock.callCount(), 0, 'the live transaction holds the authoritative membership check')
  })

  await t.test('first binding serializes the last ambient send and persists a tombstone even when the old Worker refuses control', async () => {
    const ambient = liveChannelId(scope)
    assert.equal(await channel(ordinarySession), ambient)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const sending = live.sendEnterpriseLiveInvalidations(scope, async value => {
      assert.equal(value, ambient); entered.resolve(); await release.promise
    })
    await bounded(entered.promise)
    acknowledge = false
    let attached = false
    const attaching = org.attachOrganizationWorkspace(orgId, workspaceId, owner.id).then(() => { attached = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(attached, false, 'binding waits for the WS lease held by the already authorized send')
    } finally { release.resolve(); await bounded(Promise.all([sending, attaching])) }
    assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, ambient), false)
    const marker = (await setup.query('select kind,"revokedAt","deliveredAt" from enterprise_live_capabilities where channel=$1', [ambient])).rows[0]
    assert.equal(marker.kind, 'scope'); assert.ok(marker.revokedAt); assert.equal(marker.deliveredAt, null)
    assert.equal((await live.workspaceLiveTicket(scope, ordinarySession, config)).status, 'pending')
    assert.ok(!(await emitted()).includes(ambient), 'a failed Worker ACK cannot restore ambient UUID fan-out')
    acknowledge = true
    const issued = await channel(ordinarySession)
    assert.notEqual(issued, ambient)
    assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, issued), true)
    await live.drainLiveRevocations({ organizationId: orgId })
    assert.ok(controls.length > 0)
  })

  // Real persisted identity/session bindings are used here. Protocol signing
  // and actual OIDC/SAML HTTP sign-in remain covered by http.db.test.ts.
  await setup.query('insert into enterprise_sso_provider (id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","domainTokenHash") values ($1,$2,$3,$4,$5,$6,true,$7,$8)',
    [randomUUID(), providerId, orgId, owner.id, 'https://idp.live-fixture.example.invalid', `${randomUUID()}.example.invalid`, '{}', identityTokenHash(randomUUID())])
  for (const [user, sessionId] of [[owner, ownerSession], [member, assuredSession]] as const) {
    const identity = randomUUID()
    await setup.query('insert into enterprise_identity (id,"providerId",issuer,subject,"userId") values ($1,$2,$3,$4,$5)',
      [identity, providerId, 'https://idp.live-fixture.example.invalid', user.id, user.id])
    await setup.query('update session set "enterpriseOrganizationId"=$2,"enterpriseProviderId"=$3,"enterpriseIdentityId"=$4 where id=$1', [sessionId, orgId, providerId, identity])
  }

  await t.test('enforcing SSO closes both PG gateway replicas, rejects old tickets, and preserves Personal plus a fresh assured capability', async () => {
    const ordinary = await channel(ordinarySession)
    const assured = await channel(assuredSession)
    assert.notEqual(ordinary, assured)
    const firstBus = new PostgresGatewayBus({ connectionString: target }), secondBus = new PostgresGatewayBus({ connectionString: target })
    buses.push(firstBus, secondBus)
    const first = new GatewayHub(firstBus, Date.now, secret, live.authorizeEnterpriseLiveChannel)
    const second = new GatewayHub(secondBus, Date.now, secret, live.authorizeEnterpriseLiveChannel)
    hubs.push(first, second)
    await Promise.all([firstBus.ready(), secondBus.ready()])
    const a = peer(), b = peer(), home = peer()
    const homeChanged = Promise.withResolvers<void>(), receiveHome = home.value.send
    home.value.send = data => { receiveHome(data); if (JSON.parse(data).kind === 'thread') homeChanged.resolve() }
    const socket = { kind: 'live' as const, key: ordinary, sessionId: ordinarySession, revisions: true, expiresAt: Date.now() + 60_000 }
    await first.open(a.value, socket); await second.open(b.value, socket)
    await second.open(home.value, { ...socket, key: liveChannelId(personalScope) })
    assert.equal(JSON.parse(a.messages[0]).type, 'live_ready')
    assert.equal(JSON.parse(b.messages[0]).type, 'live_ready')
    await bounded(policy(true))
    await bounded(Promise.all([a.closed, b.closed]))
    const before = a.messages.length
    await live.sendEnterpriseLiveInvalidations(scope, async value => first.live(value, [
      { kind: 'thread', id: workspaceId, rev: 12 }, { kind: 'artifact', id: workspaceId }, { kind: 'factory_task', id: workspaceId },
    ]))
    assert.equal(a.messages.length, before, 'no later Task/Artifact/Factory UUID or revision reaches the removed session')
    assert.equal(await first.authorize(socket), false)
    assert.equal((await live.workspaceLiveTicket(scope, ordinarySession, config)).status, 'denied')
    assert.equal(await channel(ordinarySession, personalScope), liveChannelId(personalScope))
    assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, liveChannelId(personalScope)), true)
    await live.sendEnterpriseLiveInvalidations(personalScope, async value => first.live(value, [{ kind: 'thread', id: personal, rev: 13 }]))
    await bounded(homeChanged.promise)
    assert.deepEqual(JSON.parse(home.messages.at(-1)!), { kind: 'thread', id: personal, rev: 13 })
    const fresh = await channel(assuredSession)
    assert.notEqual(fresh, ordinary); assert.notEqual(fresh, assured)
    assert.equal(await live.authorizeEnterpriseLiveChannel(assuredSession, fresh), true)
    assert.deepEqual(await emitted(), [fresh])
    assert.equal((await setup.query('select id from session where id=$1', [ordinarySession])).rowCount, 1, 'the ordinary Personal identity was not deleted')
  })

  await t.test('the real APP row lock delays authority commit until the bounded send finishes, then no later send passes', async () => {
    const active = await channel(assuredSession)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const sending = live.sendEnterpriseLiveInvalidations(scope, async value => {
      assert.equal(value, active); entered.resolve(); await release.promise
    })
    await bounded(entered.promise)
    const writer = await setup.connect()
    let committed = false
    try {
      await writer.query('begin')
      const { rows: [backend] } = await writer.query<{ pid: number }>('select pg_backend_pid() as pid')
      const changing = (async () => {
        await store.revokeOrganizationLiveCapabilities(writer, orgId)
        await writer.query('update enterprise_org_policy set "enforceSso"=false where "organizationId"=$1', [orgId])
        await writer.query('commit'); committed = true
      })()
      try {
        await assertBlocked(backend.pid)
        assert.equal(committed, false)
      } finally { release.resolve(); await bounded(sending); await bounded(changing) }
    } finally { await writer.query('rollback'); writer.release() }
    assert.equal(committed, true)
    assert.deepEqual(await emitted(), [], 'the committed row barrier excludes every old capability')
    assert.equal(await live.authorizeEnterpriseLiveChannel(assuredSession, active), false)
    assert.equal(appPool.totalCount, 1)
    assert.equal(workspacePool.totalCount, 1)
  })

  await t.test('SCIM failure after APP commit cannot keep the still-active WS membership emitting, and failed ACKs remain retryable', async () => {
    const ordinary = await channel(ordinarySession)
    await setup.query('insert into enterprise_scim_connection (id,"organizationId","providerId","tokenHash") values ($1,$2,$3,$4)',
      [connectionId, orgId, providerId, identityTokenHash(randomUUID())])
    const document = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], externalId: member.id, userName: member.email, active: true }
    await setup.query('insert into enterprise_scim_user (id,"connectionId","organizationId","externalId","userName","userId",document) values ($1,$2,$3,$4,$5,$6,$7)',
      [directoryId, connectionId, orgId, member.id, member.email, member.id, document])
    let failDelivery = true
    const { synchronizeDirectoryUser } = await import('./lifecycle')
    const directory = new ScimStore(appPool, async change => {
      if (failDelivery) throw new Error('isolated directory delivery failure')
      await synchronizeDirectoryUser(change)
    })
    const connection = { id: connectionId, organizationId: orgId, providerId }
    acknowledge = false
    await assert.rejects(directory.updateUser(connection, directoryId, { ...document, active: false }, false, null), /isolated directory delivery failure/)
    assert.equal((await setup.query('select active from enterprise_scim_user where id=$1', [directoryId])).rows[0].active, false)
    assert.equal((await setup.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, member.id])).rows[0].status, 'active',
      'the fixture specifically leaves the cross-database membership delivery pending')
    const revoked = (await setup.query('select "revokedAt","deliveredAt" from enterprise_live_capabilities where channel=$1', [ordinary])).rows[0]
    assert.ok(revoked.revokedAt); assert.equal(revoked.deliveredAt, null)
    assert.deepEqual(await emitted(), [], 'real SCIM authority blocks the source even while its WS outbox is broken')
    assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, ordinary), false)
    assert.equal((await live.workspaceLiveTicket(scope, ordinarySession, config)).status, 'denied')
    assert.equal(await channel(ordinarySession, personalScope), liveChannelId(personalScope))
    failDelivery = false; acknowledge = true
    const { rows: [intent] } = await setup.query<{ id: string }>('select id from enterprise_scim_outbox where "connectionId"=$1 and "deliveredAt" is null', [connectionId])
    assert.ok(intent)
    const constraint = `live_scim_ack_${randomUUID().replaceAll('-', '')}`
    await setup.query(`alter table enterprise_scim_outbox add constraint "${constraint}" check ("connectionId"<>'${connectionId}'::uuid or "deliveredAt" is null) not valid`)
    try {
      await assert.rejects(bounded(directory.drain(connection)), error => (error as { code?: string }).code === '23514')
      assert.equal((await setup.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, member.id])).rows[0].status, 'suspended',
        'the real WS commit precedes the deliberately failed APP receipt')
      assert.equal((await setup.query('select "deliveredAt" from enterprise_scim_outbox where id=$1', [intent.id])).rows[0].deliveredAt, null)
      const { rows: [memberDelivery] } = await setup.query<{ total: string; pending: string }>('select count(*) as total,count(*) filter (where "deliveredAt" is null) as pending from mikka_governance_member_outbox where "workspaceId"=$1 and "userId"=$2', [workspaceId, member.id])
      assert.ok(Number(memberDelivery.total) > 0, 'the real member-lifecycle callback ran inside the pinned WS lease')
      assert.equal(memberDelivery.pending, '0', 'its ACK commits with the WS change, without borrowing a second WS connection')
      assert.equal((await setup.query('select count(*) from mikka_organization_audit_events where id=$1', [intent.id])).rows[0].count, '1')
    } finally { await setup.query(`alter table enterprise_scim_outbox drop constraint "${constraint}"`) }
    await bounded(directory.drain(connection))
    assert.equal((await setup.query('select count(*) from mikka_organization_audit_events where id=$1', [intent.id])).rows[0].count, '1', 'an APP ACK retry does not duplicate the durable audit event')
    assert.ok((await setup.query('select "deliveredAt" from enterprise_live_capabilities where channel=$1', [ordinary])).rows[0].deliveredAt)
    assert.equal((await setup.query('select count(*) from enterprise_scim_outbox where "connectionId"=$1 and "deliveredAt" is null', [connectionId])).rows[0].count, '0')
    assert.equal((await setup.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, member.id])).rows[0].status, 'suspended')
  })

  await t.test('session deletion retains the undelivered control and cannot revive the old ticket', async () => {
    const active = await channel(ownerSession, ownerScope)
    const alternate = await channel(ordinarySession, personalScope)
    acknowledge = false
    await setup.query('delete from session where id=$1', [ownerSession])
    const revoked = (await setup.query('select "sessionId","revokedAt","deliveredAt" from enterprise_live_capabilities where channel=$1', [active])).rows[0]
    assert.equal(revoked.sessionId, ownerSession)
    assert.ok(revoked.revokedAt); assert.equal(revoked.deliveredAt, null, 'DELETE does not cascade away the durable outbox row')
    assert.equal(await live.authorizeEnterpriseLiveChannel(ownerSession, active), false)
    assert.deepEqual(await emitted(ownerScope), [])
    assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, alternate), true)
    const failed = await live.drainLiveRevocations({ workspaceId, userId: owner.id })
    assert.equal(failed.pending, true); assert.ok(failed.failed > 0)
    acknowledge = true
    assert.equal((await live.drainLiveRevocations({ workspaceId, userId: owner.id })).pending, false)
    assert.ok((await setup.query('select "deliveredAt" from enterprise_live_capabilities where channel=$1', [active])).rows[0].deliveredAt)
  })

  await t.test('registration has no session-FK lock inversion with DELETE and its late capability is revoked in the same commit', async () => {
    // The member's Personal workspace is unchanged; use a previously managed
    // unbound scope to exercise capability registration without granting the
    // now-revoked Organization membership again.
    const raceWorkspace = randomUUID()
    await setup.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Detached live race fixture\',\'team\')', [raceWorkspace, member.id])
    await setup.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,\'admin\')', [raceWorkspace, member.id, member.name, member.email])
    const raceScope = { ownerId: member.id, workspaceId: raceWorkspace }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const deleting = await setup.connect()
    let created: import('./live-store').EnterpriseLiveCapability | null = null
    try {
      await store.rememberEnterpriseLiveScope(setup, raceScope, orgId)
      const reader = { id: member.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: racingSession } }
      const registering = withTaskWorkspace(reader, raceWorkspace, async (_ws, tx) => writeTransaction(appPool, async main => {
        await store.lockLiveRegistration(main, null, racingSession)
        assert.equal(await enterpriseWorkspaceAllowed(member.id, raceWorkspace, reader[enterprisePrincipal], tx, main), true)
        entered.resolve(); await release.promise
        created = await store.registerEnterpriseLiveCapability(main, raceScope, null, racingSession)
      }))
      await bounded(entered.promise)
      await deleting.query('begin')
      const { rows: [backend] } = await deleting.query<{ pid: number }>('select pg_backend_pid() as pid')
      const removing = deleting.query('delete from session where id=$1', [racingSession])
      try { await assertBlocked(backend.pid) }
      finally { release.resolve(); await bounded(registering); await bounded(removing) }
      await deleting.query('commit')
      assert.ok(created)
      const rows = await setup.query('select channel,"revokedAt","deliveredAt" from enterprise_live_capabilities where "sessionId"=$1 and "workspaceId"=$2', [racingSession, raceWorkspace])
      assert.equal(rows.rowCount, 1); assert.ok(rows.rows[0].revokedAt); assert.equal(rows.rows[0].deliveredAt, null)
      assert.equal(await live.authorizeEnterpriseLiveChannel(racingSession, rows.rows[0].channel), false)
    } finally {
      release.resolve(); await deleting.query('rollback'); deleting.release()
      await setup.query('delete from enterprise_live_capabilities where "workspaceId"=$1', [raceWorkspace])
      await setup.query('delete from mikka_workspace_members where "workspaceId"=$1', [raceWorkspace])
      await setup.query('delete from mikka_workspaces where id=$1', [raceWorkspace])
    }
    assert.equal(appPool.totalCount, 1); assert.equal(appPool.waitingCount, 0)
    assert.equal(workspacePool.totalCount, 1); assert.equal(workspacePool.waitingCount, 0)
  })

  await t.test('provider proof reset and native DELETE keep session-row before capability-row order', async () => {
    // The administrative actor and the session being deleted are distinct.
    // The policy is currently optional; the former retains a normal Org
    // identity, while the latter owns a live capability and provider proof.
    const actorSession = randomUUID(), contendedSession = randomUUID()
    for (const id of [actorSession, contendedSession]) await setup.query('insert into session (id,"userId",token,"expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval \'1 hour\',now(),now())', [id, owner.id, randomUUID()])
    const { rows: [identity] } = await setup.query<{ id: string }>('select id from enterprise_identity where "providerId"=$1 and "userId"=$2', [providerId, owner.id])
    assert.ok(identity)
    await setup.query('update session set "enterpriseOrganizationId"=$2,"enterpriseProviderId"=$3,"enterpriseIdentityId"=$4 where id=$1', [contendedSession, orgId, providerId, identity.id])
    const capability = await channel(contendedSession, ownerScope)
    const { rows: [mainBackend] } = await appPool.query<{ pid: number }>('select pg_backend_pid() as pid')
    const deleting = await setup.connect()
    let changing: Promise<void> | undefined, mutationError: unknown
    try {
      await deleting.query('begin')
      await deleting.query('select id from session where id=$1 for update', [contendedSession])
      changing = manageIdentity(orgId, { user: owner, session: { id: actorSession } },
        { action: 'disable-provider', providerId }, 'https://live-fixture.example.invalid')
        .then(() => {}, error => { mutationError = error })
      await assertBlocked(mainBackend.pid)
      // The real management path now waits for the session row. Its Org
      // exclusive lock is held, but it must not already own this cap row:
      // DELETE's native trigger has to finish before we release that row.
      await bounded(deleting.query('delete from session where id=$1', [contendedSession]))
      await deleting.query('commit')
      await bounded(changing)
      assert.ifError(mutationError)
      assert.equal((await setup.query('select "domainVerified" from enterprise_sso_provider where "providerId"=$1', [providerId])).rows[0].domainVerified, false)
      assert.ok((await setup.query('select "revokedAt" from enterprise_live_capabilities where channel=$1', [capability])).rows[0].revokedAt)
      assert.equal(await live.authorizeEnterpriseLiveChannel(contendedSession, capability), false)
      assert.equal(await live.authorizeEnterpriseLiveChannel(ordinarySession, liveChannelId(personalScope)), true)
    } finally {
      await deleting.query('rollback'); deleting.release()
      if (changing) await bounded(changing)
    }
    assert.equal(appPool.totalCount, 1); assert.equal(appPool.waitingCount, 0)
    assert.equal(workspacePool.totalCount, 1); assert.equal(workspacePool.waitingCount, 0)
  })
})
