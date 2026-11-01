import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Pool } from 'pg'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { verifyPolicySnapshot } from '@mikka/protocol/node-policy-snapshot'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { requestDevicePolicyIssuer } from './local-cloud-issuer'
import { issuePolicySnapshot, policyDistributionContext } from './policy-distribution'
import { BASE_PATH } from '../base-path'

const ready = disposableDatabase(process.env)
if (!ready && process.env.REQUIRE_DB === '1') throw Error('Disposable loopback E2E database required')

if (process.env.LOCAL_CLOUD_ISSUER_FIXTURE !== '1') {
  test('raw HTTP cloud issuer preserves configured basePath and cloud authorization', { skip: !ready, timeout: 60_000 }, async t => {
    for (const prefix of ['/mikka', '']) await t.test(prefix || 'without basePath', () => {
      const env = { ...process.env, MIKKA_BASE_PATH: prefix, LOCAL_CLOUD_ISSUER_FIXTURE: '1' }
      delete (env as Record<string, string | undefined>).NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 25_000,
        env,
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /raw HTTP policy claim and metadata use only the operator-bound live cloud issuer/)
    })
  })
} else test('raw HTTP policy claim and metadata use only the operator-bound live cloud issuer', { skip: !ready, timeout: 60_000 }, async () => {
  const admin = new Pool({ connectionString: process.env.E2E_DATABASE_URL })
  const name = `cloud_issuer_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const target = new URL(process.env.E2E_DATABASE_URL!); target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.href })
  const oldSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'isolated-cloud-issuer-signing-fixture-0001'
  const device = randomUUID(), workspace = randomUUID(), run = randomUUID(), token = randomUUID()
  const caller = { userId: 'fixture-owner', tokenId: token, scopeDeviceId: device, scopeWorkspaceId: workspace }
  const env = { MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: target.href }
  let mode = 'local', internalOrigin = ''
  const relayIssuer = `https://relay.example${BASE_PATH}`
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.headers.authorization !== 'Bearer fixture-device') { outgoing.writeHead(401).end(); return }
      // Mimic Next's initURL at the loopback listener, including a public Host
      // and hostile forwarded headers that must never choose the signer.
      const request = new Request(`${internalOrigin}${incoming.url}`, { headers: incoming.headers as Record<string, string>, method: incoming.method })
      const issuer = await requestDevicePolicyIssuer(request, caller, device, run, { query: pool, env: mode === 'production' ? { ...env, VERCEL: '1' } : env })
      const current = { revision: 'a'.repeat(64), workspaceIds: [workspace], hierarchy: undefined, policySnapshotRequired: true }
      const context = policyDistributionContext(issuer, caller.userId, device, run, current)
      const result = incoming.url?.includes('/claim') ? issuePolicySnapshot(context, defaultRunPolicy()) : context
      outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    })().catch((error: unknown) => outgoing.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({
      fixtureError: error instanceof Error ? error.name : 'UnknownError', code: (error as { code?: string })?.code ?? null,
    })))
  })
  try {
    await pool.query(`CREATE SCHEMA mikka_test_accounts;
      CREATE TABLE mikka_test_accounts.cloud_relays(device_id uuid,owner_id text,workspace_id uuid,run_id uuid,issuer text,expires_at timestamptz);
      CREATE TABLE devices(id uuid,"ownerId" text,kind text,enabled boolean,"removedAt" timestamptz);
      CREATE TABLE agent_runs(id uuid,"userId" text,"deviceId" uuid,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE thread_machines("runId" uuid,"deviceId" uuid,"ownerId" text,"workspaceId" uuid,state text);
      CREATE TABLE device_tokens(id uuid,"userId" text,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"revokedAt" timestamptz,"expiresAt" timestamptz);`)
    await pool.query('INSERT INTO devices VALUES($1,$2,\'cloud\',true,NULL)', [device, caller.userId])
    await pool.query('INSERT INTO agent_runs VALUES($1,$2,$3,\'queued\',NULL,NULL)', [run, caller.userId, device])
    await pool.query('INSERT INTO thread_machines VALUES($1,$2,$3,$4,\'starting\')', [run, device, caller.userId, workspace])
    await pool.query('INSERT INTO device_tokens VALUES($1,$2,$3,$4,NULL,now()+interval \'1 hour\')', [token, caller.userId, device, workspace])
    await pool.query('INSERT INTO mikka_test_accounts.cloud_relays VALUES($1,$2,$3,$4,$5,now()+interval \'15 minutes\')', [device, caller.userId, workspace, run, relayIssuer])
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address === 'object')
    internalOrigin = `http://127.0.0.1:${address.port}`
    const path = `${BASE_PATH}/v1/runs/${run}/policy-snapshot?deviceId=${device}`
    const get = async (suffix = path) => fetch(`${internalOrigin}${suffix}`, { headers: { authorization: 'Bearer fixture-device', host: 'hostile.example', 'x-forwarded-host': 'another-hostile.example', 'x-forwarded-proto': 'https' } })
    const json = async (suffix?: string) => {
      const response = await get(suffix)
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body
    }
    const context = await json()
    assert.equal(context.issuer, relayIssuer)
    const signed = await json(`${BASE_PATH}/v1/devices/${device}/runs/${run}/claim`)
    assert.equal(signed.payload.issuer, relayIssuer)
    assert.equal(verifyPolicySnapshot(signed, context, { runId: run, deviceId: device, revision: 'a'.repeat(64), policy: defaultRunPolicy() }).payload.issuer, relayIssuer)
    assert.equal((await fetch(`${internalOrigin}${path}`)).status, 401)
    await pool.query('UPDATE agent_runs SET status=\'running\',"leaseExpiresAt"=now()+interval \'90 seconds\'')
    assert.equal((await json()).issuer, relayIssuer)
    await pool.query('UPDATE agent_runs SET status=\'queued\',"leaseExpiresAt"=NULL')

    for (const [change, restore] of [
      ['UPDATE devices SET kind=\'local\'', 'UPDATE devices SET kind=\'cloud\''],
      ['UPDATE device_tokens SET "revokedAt"=now()', 'UPDATE device_tokens SET "revokedAt"=NULL'],
      ['UPDATE device_tokens SET "expiresAt"=now()-interval \'1 second\'', 'UPDATE device_tokens SET "expiresAt"=now()+interval \'1 hour\''],
      ['UPDATE thread_machines SET state=\'ended\'', 'UPDATE thread_machines SET state=\'starting\''],
      ['UPDATE agent_runs SET status=\'running\',"leaseExpiresAt"=now()-interval \'1 second\'', 'UPDATE agent_runs SET status=\'queued\',"leaseExpiresAt"=NULL'],
      ['UPDATE mikka_test_accounts.cloud_relays SET expires_at=now()-interval \'1 second\'', 'UPDATE mikka_test_accounts.cloud_relays SET expires_at=now()+interval \'15 minutes\''],
      ['UPDATE mikka_test_accounts.cloud_relays SET owner_id=\'foreign-owner\'', 'UPDATE mikka_test_accounts.cloud_relays SET owner_id=\'fixture-owner\''],
      ['UPDATE mikka_test_accounts.cloud_relays SET expires_at=now()+interval \'31 minutes\'', 'UPDATE mikka_test_accounts.cloud_relays SET expires_at=now()+interval \'15 minutes\''],
    ]) {
      await pool.query(change)
      assert.equal((await json()).issuer, `${internalOrigin}${BASE_PATH}`, change)
      await pool.query(restore)
    }
    mode = 'production'
    assert.equal((await json()).issuer, `${internalOrigin}${BASE_PATH}`)
    mode = 'local'
    await pool.query('UPDATE mikka_test_accounts.cloud_relays SET issuer=$1', [`http://relay.example${BASE_PATH}`])
    assert.equal((await get()).status, 409)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = oldSecret
    await dropTestDatabase(admin, name, pool)
    await admin.end()
  }
})
