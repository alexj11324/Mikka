import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { GATEWAY_MODEL_ENDPOINT, modelAdmissionRevision, ModelAdmissionError } from './contract'

test('model admission: real workspace policy, membership, revision and audit', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { ModelAdmissionStore } = await import('./store')
  const store = new ModelAdmissionStore(pool)
  t.after(async () => {
    await pool.end()
    await (await import('../db')).pool.end()
    await (await import('../workspace-db')).workspacePool.end()
  })
  const owner = await seedUser(pool, 'model-admin'), member = await seedUser(pool, 'model-member'), stranger = await seedUser(pool, 'model-outsider')
  const one = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const two = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const identity = { workspaceId: one.id, ownerId: owner }
  const route = { provider: 'vercel-gateway', endpoint: GATEWAY_MODEL_ENDPOINT, model: 'deepseek/deepseek-v4.1-flash',
    servingProviders: ['deepseek'], dataRegions: ['unknown'], principalIds: [owner] }
  const policy = { schemaVersion: 1, routes: [route] }
  const none = modelAdmissionRevision(null)
  let revision = none
  await t.test('an admin configures one workspace and does not change the other workspace', async () => {
    assert.equal((await store.read(identity)).policy, null)
    const botId = await seedBot(pool, one.id, owner)
    const device = (await pool.query(`INSERT INTO devices(id,name,"ownerId") VALUES(gen_random_uuid(),'Native fixture',$1) RETURNING id`, [owner])).rows[0].id
    const agent = (await pool.query(`INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES(gen_random_uuid(),$1,'codex','Native fixture',$2) RETURNING id`, [owner, device])).rows[0].id
    const run = (await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","botId","deviceId",status,"leaseExpiresAt")
      VALUES(gen_random_uuid(),$1,$2,$3,$4,'running',clock_timestamp()+interval '90 seconds') RETURNING id`, [owner, agent, botId, device])).rows[0].id
    await assert.rejects(store.set(identity, none, policy), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelTransportActive')
    assert.equal((await store.read(identity)).policy, null)
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1`, [run])
    revision = (await store.set(identity, none, policy)).revision
    assert.notEqual(revision, none)
    assert.equal((await store.read({ workspaceId: two.id, ownerId: owner })).policy, null)
    const admitted = await store.gateway(identity, route.model)
    assert.deepEqual(admitted?.servingProviders, ['deepseek'])
    assert.equal(admitted?.dataRegion, 'unknown')
  })
  await t.test('an active member cannot publish rules and an outsider cannot read them', async () => {
    await assert.rejects(store.set({ ...identity, ownerId: member }, revision, policy), ModelAdmissionError)
    await assert.rejects(store.read({ ...identity, ownerId: stranger }))
    assert.equal((await store.read(identity)).revision, revision)
  })
  await t.test('model aliases, endpoint substitutions and another principal are refused', async () => {
    for (const action of [() => store.gateway(identity, 'deepseek/auto'),
      () => store.gateway(identity, route.model, 'https://proxy.example/v4/ai'),
      () => store.gateway({ ...identity, ownerId: member }, route.model),
      () => store.gateway({ workspaceId: one.id }, route.model)])
      await assert.rejects(action, ModelAdmissionError)
  })
  await t.test('stale policy writes and revoked policies cannot authorize a fresh call', async () => {
    await assert.rejects(store.set(identity, none, policy), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelPolicyChanged')
    revision = (await store.set(identity, revision, { ...policy, revoked: true })).revision
    await assert.rejects(store.gateway(identity, route.model), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelPolicyRevoked')
  })
  await t.test('unverified regions fail closed and membership removal also fences an allowed route', async () => {
    revision = (await store.set(identity, revision, { ...policy, routes: [{ ...route, dataRegions: ['eu'] }] })).revision
    await assert.rejects(store.gateway(identity, route.model), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelRegionUnverified')
    revision = (await store.set(identity, revision, policy)).revision
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [one.id, owner])
    await assert.rejects(store.gateway(identity, route.model))
  })
  await t.test('only committed policy changes produce existing audit rows without rule contents', async () => {
    const { rows } = await pool.query(`SELECT action,metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='model.policy_changed'`, [one.id])
    assert.equal(rows.length, 4)
    assert.ok(rows.every(row => row.action === 'model.policy_changed' && /^[a-f0-9]{64}$/.test(row.metadata.revision)))
    assert.ok(rows.every(row => !Object.hasOwn(row.metadata, 'routes')))
    const { rows: calls } = await pool.query(`SELECT action,metadata FROM workspace_audit_events
      WHERE "workspaceId"=$1 AND action IN ('model.admitted','model.denied')`, [one.id])
    assert.ok(calls.some(row => row.action === 'model.admitted' && row.metadata.dataRegion === 'unknown'))
    assert.ok(calls.some(row => row.action === 'model.denied' && row.metadata.reason === 'modelRouteDenied'))
    assert.ok(calls.every(row => !Object.hasOwn(row.metadata, 'prompt')))
  })
})
