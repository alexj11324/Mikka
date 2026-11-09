// Database statements of one hosted-broker context read: POST
// /v1/devices/:deviceId/runs/:runId/subscription {action:'context'} from a
// cloud computer, through the real route, device fence, run policy and model
// admission. Only E2B and the private provider worker are fixtures.
// In production this route cost about 90 statements per call (PostHog trace
// spans, 2026-11-05), most of them the run policy resolved four times.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import pg from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { fakeThreadMachines } from './support/thread-machine-fake'
import { sealSecret, userE2bKeyAad } from '../lib/secrets/crypto'

/** 82 here (about 90 in production) before the run policy was resolved once per model admission, now 52. */
const MAX_CONTEXT_STATEMENTS = 55

test('a cloud run\'s subscription context read stays within its statement budget', { skip: !dbUrl }, async t => {
  const saved = Object.fromEntries(['WORKSPACE_SECRETS_KEY', 'MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_VALIDATED_MODEL_ROUTES', 'MIKKA_BYOS_VALIDATED_NATIVE_ROUTES',
    'MIKKA_BYOS_INFISICAL_ORIGIN', 'MIKKA_BYOS_INFISICAL_PROJECT', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT', 'MIKKA_BYOS_INFISICAL_PATH',
    'MIKKA_BYOS_ACCESS_INFISICAL_PATH', 'MIKKA_BYOS_INFISICAL_TOKEN', 'MIKKA_BYOS_ACCESS_INFISICAL_TOKEN', 'MIKKA_BYOS_SHARED_CUSTODY_IDENTITY',
    'MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_FACTORY_ROUTING_ENABLED'].map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), MIKKA_BYOS_ENABLED: '1',
    MIKKA_BYOS_VALIDATED_MODEL_ROUTES: 'claude_cpa', MIKKA_BYOS_VALIDATED_NATIVE_ROUTES: 'claude_code_cli',
    // Synthetic custody configuration; the worker client is mocked below and never starts.
    MIKKA_BYOS_INFISICAL_ORIGIN: 'http://127.0.0.1:1', MIKKA_BYOS_INFISICAL_PROJECT: 'synthetic-route-queries',
    MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'test', MIKKA_BYOS_INFISICAL_PATH: '/synthetic-custody', MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/synthetic-access',
    MIKKA_BYOS_INFISICAL_TOKEN: 'synthetic-custody-token', MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: 'synthetic-distinct-access-token', MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '0',
  })
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED
  // Count what reaches Postgres. Every pool (app, workspace, device fence) runs
  // on pg.Client, and the egress sampler binds each client's query when it
  // connects, so the counter is installed before any connection opens.
  const statements: string[] = []
  let counting = false
  const query = pg.Client.prototype.query
  pg.Client.prototype.query = new Proxy(query, { apply(target, client, args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
    if (counting && typeof text === 'string') statements.push(text.replace(/\s+/g, ' ').slice(0, 120))
    return Reflect.apply(target, client, args)
  } }) as typeof query
  t.after(() => { pg.Client.prototype.query = query })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const pool = new pg.Pool({ connectionString: dbUrl, max: 5 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { bindAgentToConnection } = await import('../lib/model-dispatch')
  const { queueCloudRun } = await import('../lib/computer/queue-run')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const subscriptionRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/subscription/route')
  const { SubscriptionWorkerClient } = await import('../packages/daemon/src/subscription-worker-client')
  const harnesses = [{ harness: 'claude_code', installed: true, toolApproval: true, subscriptionBroker: true, models: ['fixture-opus'] }]
  const threadMachines = await fakeThreadMachines(pool, harnesses)
  const userId = await seedUser(pool, 'route-queries')
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    threadMachines.restore()
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId"=$1', [userId])
    for (const table of ['computer_run_bindings', 'thread_machines']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=$1`, [userId])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [userId])
    await pool.query('DELETE FROM user_e2b_keys WHERE "userId"=$1', [userId])
    for (const table of ['byos_bindings', 'byos_connections', 'bot_cloud_runtimes', 'bot_desktops', 'cloud_machines']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=$1`, [userId])
    for (const table of ['device_tokens', 'agents', 'device_repos']) await pool.query(`DELETE FROM ${table} WHERE "userId"=$1`, [userId])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [userId])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  // The person's own subscription, a workspace Bot and its task: the shape of the traced runs.
  const workspaceId = (await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])).id
  const botId = await seedBot(pool, workspaceId, userId), issueId = await seedIssue(pool, userId, workspaceId)
  const connectionId = randomUUID(), model = 'fixture-opus'
  const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota,"modelCatalog") VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'synthetic-subject',$6,$7)`,
    [connectionId, userId, workspaceId, `synthetic-${connectionId}`, 'a'.repeat(64), JSON.stringify(quota), JSON.stringify({ revision: '1', models: [model] })])
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), remote = `https://github.com/mikka-ci/route-queries-${randomUUID()}.git`
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Runner','cloud',true,$3,now(),$4)`, [deviceId, userId, DAEMON_PROTOCOL_VERSION, JSON.stringify(harnesses)])
  await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, userId, deviceId, `synthetic-${agentId}`])
  await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, userId, normalizeRepository(remote).key, remote])
  const sealed = sealSecret('synthetic-e2b-fixture', userE2bKeyAad(userId))
  await pool.query('INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,\'test\')', [userId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
  await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [workspaceId, userId, randomUUID(), `synthetic-${randomUUID()}`, deviceId])
  await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, workspaceId, userId])
  // Ordinary fresh tasks use the Bot's recorded executor identity; a parent Agent alone is not a grant.
  await pool.query('INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)', [botId, workspaceId, userId, 'claude_code', agentId, repoId])
  await bindAgentToConnection(pool, { ownerId: userId, workspaceId }, agentId, 'claude_code', connectionId, model)
  const queued = await queueCloudRun(pool, { userId, workspaceId }, { botId, issueId, agentId, deviceRepoId: repoId, title: 'Read', body: '', model, readOnly: true })
  const worker = await threadMachines.start({ userId, workspaceId }, queued.runId)
  const headers = { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${worker.token}` }
  const params = { params: Promise.resolve({ deviceId: worker.deviceId, runId: queued.runId }) }
  const claim = await claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${worker.deviceId}/runs/${queued.runId}/claim`, { method: 'POST', headers: { ...headers, [REPO_ORIGIN_HEADER]: '1' } }), params)
  assert.equal(claim.status, 200, JSON.stringify(await claim.clone().json()))

  // The private provider worker: the account and token expiry a real one reports.
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  const workerCalls: string[] = []
  t.mock.method(SubscriptionWorkerClient.prototype, 'call', async (method: string) => {
    workerCalls.push(method)
    if (method === 'prepare') return {}
    if (method === 'nativeContext') return { accountId: 'fixture-account', expiresAt }
    throw new Error(`unexpected worker operation: ${method}`)
  })
  const context = () => subscriptionRoute.POST(new Request(`http://127.0.0.1/v1/devices/${worker.deviceId}/runs/${queued.runId}/subscription`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) }), params)

  const measure = async () => {
    statements.length = 0
    counting = true
    try { return { response: await context(), count: statements.length, statements: [...statements] } }
    finally { counting = false }
  }
  await measure() // Warm the route's module and connection setup once.
  const { response, count, statements: seen } = await measure()
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const body = await response.json()
  assert.deepEqual({ ...body, revision: undefined }, { accountId: 'fixture-account', expiresAt, route: 'claude_code_cli', modelId: model, revision: undefined })
  assert.equal(typeof body.revision, 'number')
  assert.deepEqual(workerCalls.slice(-2), ['prepare', 'nativeContext'])
  t.diagnostic(`subscription context statements: ${count}`)
  assert.ok(count <= MAX_CONTEXT_STATEMENTS, `context read used ${count} statements (budget ${MAX_CONTEXT_STATEMENTS}):\n${seen.join('\n')}`)
  // The run policy is resolved once per model admission (there are two), not again for its membership lease.
  assert.equal(seen.filter(text => text.startsWith('SELECT "botId","agentId","issueId"')).length, 2, seen.join('\n'))
  assert.equal(seen.filter(text => /pg_advisory_xact_lock/.test(text)).length, 2, seen.join('\n'))

  // Authorization is unchanged: a stopped run gets no context, and no provider call.
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp() WHERE id=$1', [queued.runId])
  const before = workerCalls.length
  const stopped = await context()
  assert.equal(stopped.status, 409)
  assert.equal(workerCalls.length, before)
})
