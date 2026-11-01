// 分享给团队成员 on a person's own device (orchestration.md §2, §6), against a
// real PostgreSQL: who may take a run's subscription lease, the binding a
// member's run gets from a teammate's share, and the credential read.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('device runs on a shared subscription', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const { SubscriptionService } = await import('../lib/subscription-service')
  const { SubscriptionRepository } = await import('../lib/subscription-repository')
  const { authorizedAccessName } = await import('../lib/subscription-access-snapshot')
  const { setSubscriptionShare, sharedNativeBinding } = await import('../lib/personal-policy')
  const { authorizeSubscriptionWorkspace } = await import('../lib/subscription-runtime')
  const service = new SubscriptionService(new SubscriptionRepository(pool), () => { throw new Error('no worker in this test') },
    { ready: () => true, oauth: { codex: false, claude: false }, nativeIsolation: 'verified_runtime' }, undefined, undefined, undefined, authorizeSubscriptionWorkspace)

  const admin = await seedUser(pool, 'admin'), owner = await seedUser(pool, 'owner'), peer = await seedUser(pool, 'peer'), outsider = await seedUser(pool, 'outsider')
  const team = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: owner, role: 'member' }, { userId: peer, role: 'member' }])
  const elsewhere = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const connection = randomUUID(), access = `synthetic-access-${randomUUID()}`
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject","accessSecretName") VALUES ($1,$2,$3,'claude','connected',$4,$5,'synthetic-subject',$6)`,
    [connection, owner, team.id, `synthetic-${randomUUID()}`, 'c'.repeat(64), access])
  const { rows: [{ epoch }] } = await pool.query<{ epoch: string }>('SELECT epoch FROM byos_connections WHERE id=$1', [connection])
  // The owner's own binding in the team: the template a teammate's run is bound from.
  const ownAgent = await seedAgent(pool, owner, 'claude_code')
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,$6,'claude_code_cli','synthetic-model')`,
    [randomUUID(), owner, team.id, ownAgent, connection, epoch])

  /** A live run of `runner` on their own device, bound to `binding`. */
  const runOn = async (runner: string, agent: string, binding: string) => {
    const device = randomUUID(), run = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,harnesses) VALUES ($1,$2,'synthetic device','local',$3)`,
      [device, runner, JSON.stringify([{ harness: 'claude_code', installed: true, subscriptionBroker: true }])])
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,'running',now()+interval '5 minutes')`, [run, runner, agent, device])
    await pool.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [run, binding])
    return { run, device }
  }
  const lease = (runner: string, run: { run: string; device: string }) => service.nativeRun(runner, run.device, run.run)
  const credential = async (binding: string, consumer: string, run: string) => authorizedAccessName(pool,
    { connectionId: connection, ownerId: owner, workspaceId: team.id, provider: 'claude' } as never, { bindingId: binding, consumerId: consumer, runId: run }, Number(epoch), authorizeSubscriptionWorkspace)

  await t.test('a member\'s run is bound to a teammate\'s subscription only while it is shared for members', async () => {
    const peerAgent = await seedAgent(pool, peer, 'claude_code')
    await setSubscriptionShare(pool, owner, team.id, true, false)
    assert.equal(await sharedNativeBinding(pool, peer, peerAgent, 'claude_code', team.id), null, 'shared for the owner\'s own bots only')
    await setSubscriptionShare(pool, owner, team.id, true, true)
    const binding = await sharedNativeBinding(pool, peer, peerAgent, 'claude_code', team.id)
    assert.ok(binding)
    const { rows: [row] } = await pool.query('SELECT "ownerId","consumerId",route,"connectionId" FROM byos_bindings WHERE id=$1', [binding])
    assert.deepEqual(row, { ownerId: owner, consumerId: peerAgent, route: 'claude_code_cli', connectionId: connection })
    assert.equal(await sharedNativeBinding(pool, peer, peerAgent, 'claude_code', team.id), binding, 'the same binding again, not a new one')
    assert.equal(await sharedNativeBinding(pool, peer, peerAgent, 'codex', team.id), null, 'no Codex subscription is shared')
    assert.equal(await sharedNativeBinding(pool, outsider, await seedAgent(pool, outsider, 'claude_code'), 'claude_code', elsewhere.id), null)
  })

  await t.test('the owner and, while shared for members, a member take the lease and read the credential; nobody else', async () => {
    await setSubscriptionShare(pool, owner, team.id, true, true)
    const ownBinding = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,$6,'claude_code_cli','synthetic-model')`,
      [ownBinding, owner, team.id, ownAgent, connection, epoch])
    const own = await runOn(owner, ownAgent, ownBinding)
    assert.equal((await lease(owner, own)).ownerId, owner)
    assert.equal(await credential(ownBinding, ownAgent, own.run), access)

    const peerAgent = await seedAgent(pool, peer, 'claude_code')
    const shared = (await sharedNativeBinding(pool, peer, peerAgent, 'claude_code', team.id))!
    const peers = await runOn(peer, peerAgent, shared)
    const use = await lease(peer, peers)
    assert.equal(use.ownerId, owner, 'the use is the credential owner\'s')
    assert.equal(use.bindingId, shared)
    assert.equal(await credential(shared, peerAgent, peers.run), access)
    await assert.rejects(lease(owner, peers), /account_unavailable/, 'only the device of the run\'s own person')

    await setSubscriptionShare(pool, owner, team.id, true, false)
    await assert.rejects(lease(peer, peers), /account_unavailable/, '分享给团队成员 off')
    await assert.rejects(credential(shared, peerAgent, peers.run), /subscription_access_unavailable/)
    assert.equal((await lease(owner, own)).ownerId, owner, 'the owner\'s own run is unaffected')
  })

  await t.test('the admin switch, leaving the team, another workspace or a stop request refuse a member\'s lease', async () => {
    await setSubscriptionShare(pool, owner, team.id, true, true)
    const fresh = async () => {
      const agent = await seedAgent(pool, peer, 'claude_code')
      const binding = (await sharedNativeBinding(pool, peer, agent, 'claude_code', team.id))!
      return { agent, binding, run: await runOn(peer, agent, binding) }
    }
    const switched = await fresh()
    await pool.query(`INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false) ON CONFLICT ("workspaceId") DO UPDATE SET subscriptions=false`, [team.id])
    await assert.rejects(lease(peer, switched.run), /account_unavailable/, '允许成员使用个人订阅 off')
    await pool.query('DELETE FROM workspace_personal_policies WHERE "workspaceId"=$1', [team.id])
    assert.equal((await lease(peer, switched.run)).ownerId, owner)

    const stopped = await fresh()
    await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`, [stopped.run.run])
    await assert.rejects(lease(peer, stopped.run), /account_unavailable/, 'a stopped run')

    const left = await fresh()
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, peer])
    await assert.rejects(lease(peer, left.run), /account_unavailable/, 'not an active member any more')
    await assert.rejects(credential(left.binding, left.agent, left.run.run), /subscription_access_unavailable/)
    await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, peer])

    // An outsider's run cannot be pointed at the owner's binding.
    const outsiderAgent = await seedAgent(pool, outsider, 'claude_code'), forged = randomUUID()
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,$6,'claude_code_cli','synthetic-model')`,
      [forged, owner, team.id, outsiderAgent, connection, epoch])
    const outsiders = await runOn(outsider, outsiderAgent, forged)
    await assert.rejects(lease(outsider, outsiders), /account_unavailable/, 'not a member of the workspace')
    await assert.rejects(credential(forged, outsiderAgent, outsiders.run), /subscription_access_unavailable/)
  })
})
