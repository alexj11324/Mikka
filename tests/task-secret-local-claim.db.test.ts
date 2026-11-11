// Local functional acceptance for #1712: real PostgreSQL, route handlers,
// HttpServerLink, loopback HTTP/TLS, the production bridge and Node children.
// No model/official CLI, vendor credential, shared account or external VM.
// Next.after and the existing synthetic GitHub provider are fixture boundaries;
// DNS-to-loopback exists only in the injected TLS transport below, after
// production public-address validation. Claim authorization is not mocked.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { createServer as createTlsServer, request as tlsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { MIN_DAEMON_VERSION, type DeviceHeartbeat, type DeviceRegistration, type HeartbeatResult, type RunAssignment, type RunCheckpoint, type RunCheckpointReceipt } from '@mikka/protocol/device'
import type { RunCompletion } from '@mikka/protocol/run'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { TaskSecretAccess } from '@mikka/protocol/task-secrets'
import { taskExecutionEnv } from '../packages/daemon/src/task-env'
import { startTaskSecretBridge, type TaskSecretBridge } from '../packages/daemon/src/task-secret-bridge'
import { executeEgressRequest, pinnedEgressRequestOptions, type EgressHttpTarget, type EgressUpstreamResponse } from '../lib/secrets/egress-http'
import { taskSecretEgressResponse } from '../lib/secrets/egress-route'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub, recordPushGrant } from './support/github-app-stub'

// The daemon has its own TypeScript build. Import its current implementation at
// runtime, as the released-daemon contract test does, and share wire types.
interface LocalLink {
  registerDevice(credential: string, info: Omit<DeviceRegistration, 'deviceId'>, knownDeviceId: string): Promise<{ deviceId: string }>
  heartbeat(deviceId: string, status: DeviceHeartbeat): Promise<HeartbeatResult>
  claimRun(deviceId: string, runId: string): Promise<RunAssignment>
  checkpointRun(runId: string, checkpoint: RunCheckpoint): Promise<RunCheckpointReceipt | undefined>
  completeRun(runId: string, completion: RunCompletion): Promise<void>
}
type JournalEntry = { assignment: RunAssignment; state: 'running'; sessionId: null; worktree: null; lastSeq: number; error: null; updatedAt: string; taskSecretsWithheld?: true }

async function bytes(message: IncomingMessage) {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of message) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > 2 * 1024 * 1024) throw new Error('Fixture body limit exceeded')
    parts.push(part)
  }
  return Buffer.concat(parts)
}

const childScript = `
  const { createHash } = require('node:crypto');
  (async () => {
    const env = JSON.stringify(process.env);
    const endpoints = JSON.parse(process.env.MIKKA_SECRET_ENDPOINTS);
    const response = await fetch(endpoints.LOCAL_PROTECTED_TOKEN + '/v1/items', {
      headers: { authorization: 'Bearer mikka-protected' }, signal: AbortSignal.timeout(5000)
    });
    const body = await response.text();
    process.stdout.write(JSON.stringify({ status: response.status,
      bodyHash: createHash('sha256').update(body).digest('hex'),
      ordinaryEnv: process.env.LOCAL_FIXTURE_MODE === 'ordinary-env',
      protectedValueAbsent: !env.includes('synthetic-protected-'),
      rawCapabilityAbsent: !env.includes('mikka-egress-v1.'),
      controlCredentialsAbsent: !['WORKSPACE_SECRETS_KEY','BETTER_AUTH_SECRET','DATABASE_URL','MIKKA_DATABASE_URL','MIKKA_DEVICE_TOKEN'].some(k => k in process.env)
    }));
  })().catch(() => { process.stderr.write('child_transport_failed'); process.exitCode = 1; });
`

test('local task Secret claim, child egress, recovery and withdrawal use the real HTTP control plane', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const savedEnv = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET }
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueRun } = await import('../lib/agent-runs')
  const { reclaimLostRuns } = await import('../lib/run-leases')
  const { hashDeviceToken } = await import('../lib/device-link')
  const personal = await import('../lib/secrets/user-store')
  const linkModule = new URL('../packages/daemon/src/server-link-http.ts', import.meta.url).href
  const journalModule = new URL('../packages/daemon/src/runs/journal.ts', import.meta.url).href
  const { HttpServerLink } = await import(linkModule) as { HttpServerLink: new (base: string, fetcher: typeof fetch, version: string) => LocalLink }
  const { RunJournal } = await import(journalModule) as { RunJournal: new (path: string) => { put(entry: JournalEntry): void; get(runId: string): JournalEntry | undefined } }
  const routes = {
    register: await import('../app/v1/devices/register/route'),
    heartbeat: await import('../app/v1/devices/[deviceId]/heartbeat/route'),
    claim: await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route'),
    checkpoint: await import('../app/v1/runs/[runId]/checkpoint/route'),
    complete: await import('../app/v1/runs/[runId]/complete/route'),
  }
  const directory = await mkdtemp(join(tmpdir(), 'mikka-secret-local-'))
  const github = githubAppStub()
  const bridges: TaskSecretBridge[] = [], controllers: AbortController[] = []
  const servers: Array<ReturnType<typeof createServer> | ReturnType<typeof createTlsServer>> = []
  const owners: string[] = []
  t.after(async () => {
    try {
      for (const controller of controllers) controller.abort()
      for (const bridge of bridges) bridge.close()
      for (const server of servers.reverse()) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
      for (const owner of owners) {
        await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
        await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId"=$1', [owner])
        for (const table of ['agent_runs', 'agents', 'device_repos', 'device_tokens', 'user_secrets', 'repository_settings', 'issues'])
          await pool.query(`DELETE FROM ${table} WHERE "userId"=$1`, [owner])
        await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
        await pool.query('DELETE FROM bots WHERE "ownerId"=$1', [owner])
        await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [owner])
        await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [owner])
        await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
      }
    } finally {
      github.restore()
      await rm(directory, { recursive: true, force: true })
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  // This fixture's private key and synthetic task value never cross to the child.
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=api.fixture.test', '-days', '1', '-addext', 'subjectAltName=DNS:api.fixture.test'], { stdio: 'ignore' })
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)])
  const protectedValue = 'synthetic-protected-' + randomBytes(24).toString('hex')
  const responseBody = JSON.stringify({ fixture: 'authorized' })
  let upstreamRequests = 0
  const provider = createTlsServer({ key, cert }, (request, response) => {
    upstreamRequests++
    const authorized = request.headers.authorization === `Bearer ${protectedValue}` && request.url === '/v1/items' && request.method === 'GET'
    response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' })
    response.end(authorized ? responseBody : '{"fixture":"denied"}')
  })
  servers.push(provider)
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const providerOrigin = `https://api.fixture.test:${(provider.address() as AddressInfo).port}`
  const transport = async (target: EgressHttpTarget, signal: AbortSignal): Promise<EgressUpstreamResponse> => {
    assert.equal(target.url.origin, providerOrigin)
    const local = { ...target, address: { address: '127.0.0.1', family: 4 } }
    return new Promise((resolve, reject) => {
      const request = tlsRequest(local.url, { ...pinnedEgressRequestOptions(local, signal), ca: cert }, response => {
        void bytes(response).then(body => {
          const headers: Array<[string, string]> = []
          for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push([response.rawHeaders[i], response.rawHeaders[i + 1]])
          resolve({ status: response.statusCode!, headers, body })
        }, reject)
      })
      request.once('error', reject)
      request.end(target.body)
    })
  }
  const routeErrors: string[] = []
  let base = ''
  const application = createServer((incoming, outgoing) => {
    void (async () => {
      const body = await bytes(incoming)
      const headers = new Headers()
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1])
      const request = new Request(new URL(incoming.url!, base), { method: incoming.method, headers, ...(body.length ? { body: new Uint8Array(body) } : {}) })
      const path = new URL(request.url).pathname.replace(/^\/mikka(?=\/)/, '')
      const match = (pattern: RegExp) => path.match(pattern)?.slice(1)
      let found: string[] | undefined, result: Response
      if (path === '/v1/devices/register') result = await routes.register.POST(request)
      else if ((found = match(/^\/v1\/devices\/([^/]+)\/heartbeat$/))) result = await routes.heartbeat.POST(request, { params: Promise.resolve({ deviceId: found[0] }) })
      else if ((found = match(/^\/v1\/devices\/([^/]+)\/runs\/([^/]+)\/claim$/))) result = await routes.claim.POST(request, { params: Promise.resolve({ deviceId: found[0], runId: found[1] }) })
      else if ((found = match(/^\/v1\/runs\/([^/]+)\/checkpoint$/))) result = await routes.checkpoint.POST(request, { params: Promise.resolve({ runId: found[0] }) })
      else if ((found = match(/^\/v1\/runs\/([^/]+)\/complete$/))) result = await routes.complete.POST(request, { params: Promise.resolve({ runId: found[0] }) })
      else if ((found = match(/^\/v1\/task-secrets\/([^/]+)$/))) result = await taskSecretEgressResponse(request, found[0], (input, binding, options) =>
        executeEgressRequest(input, binding, { ...options, resolve: async () => [{ address: '93.184.216.34', family: 4 }], transport }))
      else result = new Response(null, { status: 404 })
      outgoing.writeHead(result.status, Object.fromEntries(result.headers))
      outgoing.end(Buffer.from(await result.arrayBuffer()))
    })().catch(error => {
      // A database/client cause may contain credentials: retain only closed codes.
      const code: unknown = error?.code
      routeErrors.push(typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'route_failure')
      outgoing.writeHead(500, { 'content-type': 'application/json' }); outgoing.end('{"error":"fixture_route_failed"}')
    })
  })
  servers.push(application)
  await new Promise<void>(resolve => application.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(application.address() as AddressInfo).port}`
  const owner = await seedUser(pool, 'secret-local-owner'), outsider = await seedUser(pool, 'secret-local-outsider')
  owners.push(owner, outsider)
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const botId = await seedBot(pool, workspace.id, owner), issueId = await seedIssue(pool, owner, workspace.id)
  await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } } })])
  const repository = `mikka-ci/secret-local-${randomUUID()}`
  const remote = `https://github.com/${repository}.git`
  const githubAccountId = '9100001'
  github.install(repository, { contents: 'write', pull_requests: 'write' })
  github.allowWriter(repository, githubAccountId)
  // Current HttpServerLink requests preparation credentials. A push grant alone
  // is not a usable GitHub connection: seal a synthetic owner token normally and
  // let the real claim path validate it against the existing provider fixture.
  const githubToken = await connectGitHub(github, owner, githubAccountId, [repository])
  await recordPushGrant(pool, owner, normalizeRepository(remote).key, githubAccountId)
  const harnesses = [{ harness: 'claude_code' as const, installed: true, version: '2.1.0', toolApproval: true as const }]
  const device = async (userId: string) => {
    const id = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), token = 'synthetic-' + randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"daemonVersion","protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Local fixture','local',true,$3,$4,now(),$5)`,
      [id, userId, MIN_DAEMON_VERSION, DAEMON_PROTOCOL_VERSION, JSON.stringify(harnesses)])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'claude_code',$4)`, [agentId, userId, id, `fixture-${agentId}`])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, id, userId, normalizeRepository(remote).key, remote])
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), userId, hashDeviceToken(token)])
    const link = new HttpServerLink(base, fetch, MIN_DAEMON_VERSION)
    assert.equal((await link.registerDevice(token, { name: 'Local fixture', platform: 'linux', arch: 'x64', daemonVersion: MIN_DAEMON_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION, harnesses }, id)).deviceId, id)
    return { id, agentId, token, link }
  }
  const a = await device(owner), b = await device(owner), foreign = await device(outsider)
  const saved = await personal.createUserSecret(owner, { name: 'LOCAL_PROTECTED_TOKEN', kind: 'secret', value: protectedValue,
    delivery: { mode: 'protected', http: { origin: providerOrigin, header: 'authorization', prefix: 'Bearer ', rules: [{ method: 'GET', path: '/v1/items', match: 'exact' }] } } }, {})
  await personal.createUserSecret(owner, { name: 'LOCAL_FIXTURE_MODE', kind: 'env', value: 'ordinary-env' }, {})
  const { runId } = await queueRun(owner, { issueId, agentId: a.agentId, repo: remote, model: 'fixture-model',
    modelDispatch: { mode: 'preference', routing: { version: 1, difficulty: 'hard', model: 'fixture-model', harness: 'claude_code', tier: 'standard', effort: 'high', reason: 'difficulty_fit' } } }, botId)
  const claimStatus = async (token: string, deviceId: string) => {
    const response = await fetch(`${base}/v1/devices/${deviceId}/runs/${runId}/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, [CLIENT_VERSION_HEADER]: MIN_DAEMON_VERSION } })
    await response.arrayBuffer()
    return response.status
  }
  await t.test('another owner and another device cannot claim the queued run', async () => {
    assert.equal(await claimStatus(foreign.token, a.id), 404)
    assert.equal(await claimStatus(b.token, b.id), 409)
  })
  const assignment = await a.link.claimRun(a.id, runId)
  assert.equal(assignment.github?.token === githubToken, true, 'the current client receives its own prepared GitHub credential')
  assert.equal(github.calls.includes('GET /user'), true, 'claim validates the synthetic provider identity')
  assert.ok(assignment.taskSecrets?.grants.length === 1)
  const firstAccess = assignment.taskSecrets
  const state = { current: firstAccess as TaskSecretAccess | undefined }
  const startBridge = async (current: () => TaskSecretAccess | undefined) => {
    const controller = new AbortController(); controllers.push(controller)
    const bridge = await startTaskSecretBridge({ current, signal: controller.signal })
    assert.ok(bridge)
    bridges.push(bridge)
    return bridge
  }
  const bridgeA = await startBridge(() => state.current)
  const child = async (claimed: RunAssignment, bridge: TaskSecretBridge) => {
    const env = taskExecutionEnv({}, { taskEnv: claimed.taskEnv, taskSecretEnv: bridge.env })
    const result = await promisify(execFile)(process.execPath, ['-e', childScript], { cwd: directory, env: { ...env, NODE_ENV: 'test' }, timeout: 8_000, maxBuffer: 16_384 })
    assert.equal(result.stderr, '')
    const receipt = JSON.parse(result.stdout) as { status: number; bodyHash: string; ordinaryEnv: boolean; protectedValueAbsent: boolean; rawCapabilityAbsent: boolean; controlCredentialsAbsent: boolean }
    assert.equal(receipt.ordinaryEnv && receipt.protectedValueAbsent && receipt.rawCapabilityAbsent && receipt.controlCredentialsAbsent, true)
    return receipt
  }
  await t.test('claimed grants reach a real child only through the bridge and are withheld from its journal', async () => {
    assert.equal(JSON.stringify(assignment).includes(protectedValue), false)
    assert.equal(Object.hasOwn(assignment.taskEnv ?? {}, 'LOCAL_PROTECTED_TOKEN'), false)
    const receipt = await child(assignment, bridgeA)
    assert.equal(receipt.status, 200)
    assert.equal(receipt.bodyHash, createHash('sha256').update(responseBody).digest('hex'))
    const journalPath = join(directory, 'runs.json'), journal = new RunJournal(journalPath)
    journal.put({ assignment, state: 'running', sessionId: null, worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
    const raw = await readFile(journalPath, 'utf8')
    assert.equal(raw.includes(protectedValue) || raw.includes('mikka-egress-v1.'), false)
    const restored = new RunJournal(journalPath).get(runId)
    assert.equal(restored?.taskSecretsWithheld, true)
    assert.equal(restored?.assignment.taskSecrets, undefined)
    assert.equal(restored?.assignment.taskEnv, undefined)
  })
  const reportRun = (id: string, access: TaskSecretAccess) => ({ runId: id, lastProgressAt: new Date().toISOString(), secretCapabilities: access.grants.map(grant => grant.capability) })
  await t.test('the ordinary heartbeat renews the opaque capability and cross-run replay is rejected before TLS', async () => {
    const beat = await a.link.heartbeat(a.id, { harnesses, runs: [reportRun(runId, firstAccess)], worktreeDiskBytes: 0 })
    assert.ok(beat.leases[runId] && beat.taskSecrets?.[runId])
    state.current = beat.taskSecrets[runId]
    assert.equal(JSON.stringify(beat).includes(protectedValue), false)
    const before = upstreamRequests
    const replay = await fetch(`${base}/v1/task-secrets/${randomUUID()}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: state.current.grants[0].capability, method: 'GET', path: '/v1/items', headers: [] }) })
    assert.equal(replay.status, 401)
    assert.equal((await replay.json()).detail, 'binding_mismatch')
    assert.equal(upstreamRequests, before)
  })
  let retry: RunAssignment
  await t.test('a real checkpoint and expired local lease recover onto B with a new grant', async () => {
    const receipt = await a.link.checkpointRun(runId, { baseCommit: 'a'.repeat(40), patch: gzipSync('').toString('base64'), files: 0, takenAt: new Date().toISOString() })
    assert.equal(receipt?.runId, runId)
    // Controlled liveness input on this test's rows; the recovery and admission
    // decisions, new retryOf row and claim all come from production functions.
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '10 minutes' WHERE id=$1 AND "ownerId"=$2`, [a.id, owner])
    await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1 AND "userId"=$2`, [runId, owner])
    await reclaimLostRuns(owner)
    const rows = (await pool.query<{ id: string; deviceId: string; attempt: number }>('SELECT id,"deviceId",attempt FROM agent_runs WHERE "retryOf"=$1 AND "userId"=$2', [runId, owner])).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].deviceId, b.id)
    assert.equal(rows[0].attempt, 2)
    retry = await b.link.claimRun(b.id, rows[0].id)
    assert.ok(retry.taskSecrets?.grants.length === 1)
    assert.equal(retry.resumeFrom?.baseCommit, 'a'.repeat(40))
    assert.equal(retry.taskSecrets.grants[0].capability === firstAccess.grants[0].capability, false)
    const oldBeat = await a.link.heartbeat(a.id, { harnesses, runs: [reportRun(runId, state.current!)], worktreeDiskBytes: 0 })
    assert.ok(oldBeat.revoked?.includes(runId))
    assert.equal(oldBeat.taskSecrets?.[runId], undefined)
    state.current = undefined
    assert.equal((await child(assignment, bridgeA)).status, 409)
    const retryBridge = await startBridge(() => retry.taskSecrets)
    assert.equal((await child(retry, retryBridge)).status, 200)
  })
  await t.test('changing the stored Secret withdraws B on its next heartbeat and the bridge refuses further child requests', async () => {
    assert.ok(retry?.taskSecrets)
    const held = { current: retry.taskSecrets as TaskSecretAccess | undefined }
    const bridge = await startBridge(() => held.current)
    await personal.replaceUserSecret(owner, { id: saved.id, value: 'synthetic-protected-' + randomBytes(24).toString('hex') })
    const beat = await b.link.heartbeat(b.id, { harnesses, runs: [reportRun(retry.runId, retry.taskSecrets)], worktreeDiskBytes: 0 })
    assert.ok(beat.revoked?.includes(retry.runId))
    assert.equal(beat.leases[retry.runId], undefined)
    assert.equal(beat.taskSecrets?.[retry.runId], undefined)
    held.current = undefined
    assert.equal((await child(retry, bridge)).status, 409)
    await b.link.completeRun(retry.runId, { stopReason: 'cancelled', report: { summary: 'Local Secret withdrawal fixture', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
    const row = (await pool.query<{ status: string; stopReason: string }>('SELECT status,"stopReason" FROM agent_runs WHERE id=$1 AND "userId"=$2', [retry.runId, owner])).rows[0]
    // A daemon completion with stopReason=cancelled is terminal "cancelled"
    // under runStateForStop; "stopped" belongs to turn/human/blocked stops.
    assert.equal(row.status, 'cancelled')
    assert.equal(row.stopReason, 'cancelled')
  })
  assert.deepEqual(routeErrors, [])
  assert.equal(upstreamRequests, 2, 'only the two authorized child requests reached the TLS fixture')
})
