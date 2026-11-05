import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { loadEnvironment } from '../scripts/test-accounts/environment.mjs'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'
import { captureNativeResources } from '../apps/desktop/test/native-resources.mjs'

// The CI pool job supplies an independently attested, disposable PG target.
// These synthetic rows exercise cleanup, not sign-in or daemon acceptance.
test('native test cleanup fences the real lease, baseline and database graph', { timeout: 120_000 }, async t => {
  const environment = await loadEnvironment()
  const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
  const pool = new TestAccountPool(database, environment)
  const pairId = `native-${randomUUID()}`, leaseId = randomUUID()
  const users = Array.from({ length: 3 }, () => `native-${randomUUID()}`)
  const devices = [], agents = [], tokens = [], enrollments = [], authStates = [], reviews = []
  const lease = { id: leaseId, environmentId: environment.id, pairId, generation: 1, runId: pairId, workerId: 'native-cleanup-fixture' }
  const scope = { pool, lease, owner: { userId: users[0] }, peer: { userId: users[1] }, assertActive: () => pool.assertLease(lease) }
  const count = async (table, key, ids) => Number((await database.query(`SELECT count(*) AS n FROM ${table} WHERE "${key}"::text=ANY($1::text[])`, [ids])).rows[0].n)
  async function localDevice(owner, kind = 'local') {
    const id = randomUUID(); devices.push(id)
    await database.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,$3,$4)', [id, owner, 'Fixture device', kind])
    return id
  }
  async function graph(owner) {
    const device = await localDevice(owner), agent = randomUUID(), token = randomUUID(), repo = randomUUID(), command = randomUUID()
    agents.push(agent); tokens.push(token)
    const hash = randomBytes(32).toString('hex'); enrollments.push(hash)
    const state = randomBytes(32).toString('hex'); authStates.push(state)
    await database.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',$3,$4)', [agent, owner, `codex ${device}`, device])
    await database.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,\'SSH\',$3)', [token, owner, randomBytes(32).toString('hex')])
    await database.query('INSERT INTO device_token_devices("tokenId","deviceId","userId") VALUES($1,$2,$3)', [token, device, owner])
    await database.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,\'/tmp/native-fixture\')', [repo, device, owner])
    await database.query('INSERT INTO device_management_commands(id,"deviceId",kind) VALUES($1,$2,\'redetect\')', [command, device])
    await database.query('INSERT INTO device_enrollments("tokenHash","userId","expiresAt") VALUES($1,$2,now()+interval \'5 minutes\')', [hash, owner])
    await database.query('INSERT INTO desktop_auth_requests("stateHash","userId",callback,"codeChallenge","expiresAt","boundAt","usedAt") VALUES($1,$2,\'http://127.0.0.1:51876/auth/callback\',$3,now()+interval \'1 minute\',now(),now())', [state, owner, randomBytes(32).toString('base64url')])
    return { device, agent, token, hash, state }
  }
  try {
    await pool.prepare({ pairs: 1 })
    // Every identifier is fresh. The fixture does not adopt a retained account,
    // change another pair's lease, or weaken the pool's resource reservation.
    await pool.transaction(async client => {
      await client.query('INSERT INTO mikka_test_accounts.pairs(id,environment_id,generation,state,active_lease_id) VALUES($1,$2,1,\'leased\',$3)', [pairId, environment.id, leaseId])
      await client.query('INSERT INTO mikka_test_accounts.leases(id,environment_id,request_id,run_id,worker_id,pair_id,generation,expires_at,ttl_ms,state) VALUES($1,$2,$3,$3,$4,$3,1,clock_timestamp()+interval \'5 minutes\',300000,\'active\')', [leaseId, environment.id, pairId, lease.workerId])
      for (const user of users) await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,false,now(),now())', [user, `${user}@example.invalid`])
      for (const [index, role] of ['owner', 'peer'].entries()) await client.query('INSERT INTO mikka_test_accounts.accounts(slot_id,pair_id,role,user_id) VALUES($1,$2,$3,$4)', [`${pairId}:${role}`, pairId, role, users[index]])
    })
    const baseline = await localDevice(users[0]), foreign = await localDevice(users[2])
    const baselineRow = (await database.query('SELECT to_jsonb(d) AS row FROM devices d WHERE id=$1', [baseline])).rows[0].row

    await t.test('cleanup requires real daemon drain and preserves both leased baseline and foreign rows', async () => {
      const captured = await captureNativeResources(scope)
      const owner = await graph(users[0]), peer = await graph(users[1])
      await assert.rejects(captured.cleanup(), { code: 'NATIVE_DAEMONS_NOT_DRAINED' })
      assert.equal(await count('devices', 'id', [owner.device, peer.device]), 2)
      const result = await captured.cleanup({ drained: true })
      assert.equal(result.cleaned, true)
      assert.ok(Object.values(result.counts).every(value => value === 2))
      assert.equal(await count('devices', 'id', [owner.device, peer.device]), 0)
      assert.equal(await count('device_tokens', 'id', [owner.token, peer.token]), 0)
      assert.equal(await count('device_enrollments', 'tokenHash', [owner.hash, peer.hash]), 0)
      assert.equal(await count('desktop_auth_requests', 'stateHash', [owner.state, peer.state]), 0)
      assert.equal(await count('devices', 'id', [baseline, foreign]), 2)
      assert.deepEqual((await database.query('SELECT to_jsonb(d) AS row FROM devices d WHERE id=$1', [baseline])).rows[0].row, baselineRow)
      assert.ok(Object.values((await captured.cleanup({ drained: true })).counts).every(value => value === 0))
    })
    await t.test('a changed baseline refuses all deletion', async () => {
      const captured = await captureNativeResources(scope)
      const created = await graph(users[0])
      await database.query('UPDATE devices SET name=\'Changed baseline\' WHERE id=$1', [baseline])
      await assert.rejects(captured.cleanup({ drained: true }), { code: 'NATIVE_RESOURCE_BASELINE_CHANGED' })
      assert.equal(await count('devices', 'id', [created.device]), 1)
      await database.query('UPDATE devices SET name=$2 WHERE id=$1', [baseline, baselineRow.name])
      await captured.cleanup({ drained: true })
    })
    await t.test('new cloud devices and foreign device bindings are never cleanup targets', async () => {
      const captured = await captureNativeResources(scope)
      const cloud = await localDevice(users[0], 'cloud')
      await assert.rejects(captured.cleanup({ drained: true }), { code: 'NATIVE_RESOURCE_UNRELATED' })
      await database.query('DELETE FROM devices WHERE id=$1', [cloud])
      const created = await graph(users[0]), foreignAgent = randomUUID(); agents.push(foreignAgent)
      await database.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',$3,$4)', [foreignAgent, users[2], `foreign ${foreignAgent}`, created.device])
      await assert.rejects(captured.cleanup({ drained: true }), { code: 'NATIVE_RESOURCE_REFERENCED' })
      assert.equal(await count('device_tokens', 'id', [created.token]), 1)
      await database.query('DELETE FROM agents WHERE id=$1', [foreignAgent])
      await captured.cleanup({ drained: true })
    })
    await t.test('a cascade-linked runtime turn is detected before any graph rows are deleted', async () => {
      const captured = await captureNativeResources(scope)
      const created = await graph(users[0]), turn = randomUUID(); reviews.push(turn)
      await database.query('INSERT INTO native_coordinator_turns(id,"userId","deviceId",holder,round,payload,"expiresAt") VALUES($1,$2,$3,$4,1,\'{}\',now()+interval \'5 minutes\')', [turn, users[0], created.device, turn])
      await assert.rejects(captured.cleanup({ drained: true }), { code: 'NATIVE_RESOURCE_REFERENCED' })
      assert.equal(await count('devices', 'id', [created.device]), 1)
      assert.equal(await count('native_coordinator_turns', 'id', [turn]), 1)
      await database.query('DELETE FROM native_coordinator_turns WHERE id=$1', [turn])
      await captured.cleanup({ drained: true })
    })
    await t.test('ownership and expired-lease fences hold before cleanup writes', async () => {
      await assert.rejects(captureNativeResources({ ...scope, owner: { userId: users[2] } }), { code: 'NATIVE_RESOURCE_SCOPE_MISMATCH' })
      await assert.rejects(captureNativeResources({ ...scope, pool: { transaction: () => { throw new Error('must not run') } } }), { code: 'NATIVE_RESOURCE_SCOPE_REQUIRED' })
      const captured = await captureNativeResources(scope)
      const created = await graph(users[0])
      await database.query('UPDATE mikka_test_accounts.leases SET expires_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [leaseId])
      await assert.rejects(captured.cleanup({ drained: true }), { code: 'LEASE_LOST' })
      assert.equal(await count('devices', 'id', [created.device]), 1)
      // Only this synthetic fixture's deadline is restored for its exact-ID
      // teardown. The helper never renews or repairs a lost production lease.
      await database.query('UPDATE mikka_test_accounts.leases SET expires_at=clock_timestamp()+interval \'5 minutes\' WHERE id=$1', [leaseId])
      await captured.cleanup({ drained: true })
    })
  } finally {
    await pool.transaction(async client => {
      for (const [table, key, ids] of [
        ['native_coordinator_turns', 'id', reviews], ['device_token_devices', 'tokenId', tokens],
        ['device_management_commands', 'deviceId', devices], ['device_repos', 'deviceId', devices], ['agents', 'id', agents],
        ['device_tokens', 'id', tokens], ['device_enrollments', 'tokenHash', enrollments], ['desktop_auth_requests', 'stateHash', authStates], ['devices', 'id', devices],
      ]) await client.query(`DELETE FROM public.${table} WHERE "${key}"::text=ANY($1::text[])`, [ids])
      await client.query('DELETE FROM mikka_test_accounts.accounts WHERE pair_id=$1', [pairId])
      await client.query('DELETE FROM mikka_test_accounts.leases WHERE id=$1', [leaseId])
      await client.query('DELETE FROM mikka_test_accounts.pairs WHERE id=$1', [pairId])
      await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    })
    await database.end()
  }
})
