import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { observePoolCommits } from '../db/commit-effects'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { modelAdmissionRevision, ModelAdmissionError } from './contract'

test('model admission: real workspace policy, membership, revision and audit', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  observePoolCommits(pool)
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
  const route = { provider: 'litellm', endpoint: 'https://models.example.test/v1', model: 'mikka-default',
    servingProviders: ['litellm'], dataRegions: ['unknown'], principalIds: [owner] }
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
    const admitted = await store.litellm(identity, route.model, route.endpoint)
    assert.deepEqual(admitted?.servingProviders, ['litellm'])
    assert.equal(admitted?.dataRegion, 'unknown')
  })
  await t.test('an active member cannot publish rules and an outsider cannot read them', async () => {
    await assert.rejects(store.set({ ...identity, ownerId: member }, revision, policy), ModelAdmissionError)
    await assert.rejects(store.read({ ...identity, ownerId: stranger }))
    assert.equal((await store.read(identity)).revision, revision)
  })
  await t.test('model aliases, endpoint substitutions and another principal are refused', async () => {
    for (const action of [() => store.litellm(identity, 'mikka-title', route.endpoint),
      () => store.litellm(identity, route.model, 'https://proxy.example/v4/ai'),
      () => store.litellm({ ...identity, ownerId: member }, route.model, route.endpoint),
      () => store.litellm({ workspaceId: one.id }, route.model, route.endpoint)])
      await assert.rejects(action, ModelAdmissionError)
  })
  await t.test('stale policy writes and revoked policies cannot authorize a fresh call', async () => {
    await assert.rejects(store.set(identity, none, policy), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelPolicyChanged')
    revision = (await store.set(identity, revision, { ...policy, revoked: true })).revision
    await assert.rejects(store.litellm(identity, route.model, route.endpoint), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelPolicyRevoked')
  })
  await t.test('unverified regions fail closed and membership removal also fences an allowed route', async () => {
    revision = (await store.set(identity, revision, { ...policy, routes: [{ ...route, dataRegions: ['eu'] }] })).revision
    await assert.rejects(store.litellm(identity, route.model, route.endpoint), (e: unknown) => e instanceof ModelAdmissionError && e.code === 'modelRegionUnverified')
    revision = (await store.set(identity, revision, policy)).revision
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [one.id, owner])
    await assert.rejects(store.litellm(identity, route.model, route.endpoint))
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
  await t.test('retired policies deny execution but an admin can explicitly replace their exact revision', async () => {
    const scope = { workspaceId: two.id, ownerId: owner }
    const retired = { schemaVersion: 1, routes: [{ provider: 'vercel-gateway', endpoint: 'https://retired.example/v4/ai', model: 'vendor/model', servingProviders: ['vendor'], dataRegions: ['unknown'] }] }
    await pool.query(`INSERT INTO workspace_computer_policies("workspaceId",permission,model_admission)
      VALUES($1,'allow',$2) ON CONFLICT("workspaceId") DO UPDATE SET model_admission=EXCLUDED.model_admission`, [two.id, retired])
    const previous = await store.read(scope)
    assert.deepEqual(previous.policy, retired)
    await assert.rejects(store.litellm(scope, route.model, route.endpoint), { code: 'modelPolicyInvalid' })
    const replacement = await store.set(scope, previous.revision, policy)
    assert.ok(await store.litellm(scope, route.model, route.endpoint))
    await store.set(scope, replacement.revision, null)
  })
  await t.test('a second workspace grants only its own exact LiteLLM endpoint', async () => {
    const other = { workspaceId: two.id, ownerId: owner }
    const localRoute = { ...route, endpoint: 'https://second.example.test/v1' }
    await store.set(other, none, { schemaVersion: 1, routes: [localRoute] })
    assert.ok(await store.litellm(other, route.model, localRoute.endpoint))
    await assert.rejects(store.litellm(other, route.model, route.endpoint), /modelRouteDenied/)
    await assert.rejects(store.litellm({ ...other, ownerId: member }, route.model, localRoute.endpoint))
    const { rows } = await pool.query('select metadata from workspace_audit_events where "workspaceId"=$1 and action=$2', [two.id, 'model.admitted'])
    assert.ok(rows.some(row => row.metadata.provider === 'litellm' && row.metadata.endpoint === localRoute.endpoint && row.metadata.model === route.model))
  })
})
