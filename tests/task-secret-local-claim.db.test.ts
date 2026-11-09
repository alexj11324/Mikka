// Local functional acceptance for #1712: real PostgreSQL, route handlers,
// HttpServerLink, loopback HTTP/TLS, the production bridge and Node children.
// No model/official CLI, vendor credential, shared account or external VM.
// Next.after and the existing synthetic GitHub provider are fixture boundaries;
// request headers/locale use the API's own compatibility scope for downloads.
// DNS-to-loopback exists only in the injected TLS transport below, after
// production public-address validation. Claim authorization is not mocked.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { dbUrl, seedBot, seedIssue, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'
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
    const response = await fetch(endpoints[process.env.LOCAL_ENDPOINT_NAME || 'LOCAL_PROTECTED_TOKEN'] + (process.env.LOCAL_ENDPOINT_PATH || '/v1/items'), {
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
  // Use the same request adapters as the standalone API. Neither session nor
  // workspace/object authorization readers are replaced with fixture values.
  const requestHeaders = await import('../apps/api/compat/headers')
  const requestIntl = await import('../apps/api/compat/intl')
  mock.module('next/headers', { namedExports: { ...requestHeaders } })
  mock.module('next-intl/server', { namedExports: { ...requestIntl } })
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueRun } = await import('../lib/agent-runs')
  const { reclaimLostRuns } = await import('../lib/run-leases')
  const { hashDeviceToken } = await import('../lib/device-link')
  const personal = await import('../lib/secrets/user-store')
  const shared = await import('../lib/secrets/store')
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
    delivery: await import('../app/api/secrets/delivery/route'),
    artifact: await import('../app/api/artifacts/[artifactId]/versions/[version]/download/route'),
    capture: await import('../app/api/captures/[captureId]/route'),
  }
  const directory = await mkdtemp(join(tmpdir(), 'mikka-secret-local-'))
  const github = githubAppStub()
  const bridges: TaskSecretBridge[] = [], controllers: AbortController[] = []
  const servers: Array<ReturnType<typeof createServer> | ReturnType<typeof createTlsServer>> = []
  const owners: string[] = [], ownedWorkspaces: string[] = []
  t.after(async () => {
    try {
      for (const controller of controllers) controller.abort()
      for (const bridge of bridges) bridge.close()
      for (const server of servers.reverse()) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
      for (const workspaceId of ownedWorkspaces) {
        for (const table of ['workspace_secrets', 'workspace_audit_outbox', 'workspace_audit_events'])
          await pool.query(`DELETE FROM ${table} WHERE "workspaceId"=$1`, [workspaceId])
      }
      for (const owner of owners) {
        await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
        await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId"=$1', [owner])
        for (const table of ['artifacts', 'run_captures', 'agent_runs', 'agents', 'device_repos', 'device_tokens', 'user_secrets', 'repository_settings', 'issues'])
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
  let upstreamRequests = 0, scopeRequests = 0, scopeDenied = 0
  let expectedScopedValue: string | undefined
  const provider = createTlsServer({ key, cert }, (request, response) => {
    const scoped = request.url === '/v1/scope'
    if (scoped) scopeRequests++
    else upstreamRequests++
    const expected = scoped ? expectedScopedValue : protectedValue
    const authorized = expected !== undefined && request.headers.authorization === `Bearer ${expected}`
      && (scoped || request.url === '/v1/items') && request.method === 'GET'
    if (scoped && !authorized) scopeDenied++
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
  const routeErrors: string[] = [], objectRequests: string[] = []
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
      if (path === '/api/secrets/delivery' && request.method === 'PATCH') result = await routes.delivery.PATCH(request)
      else if (path === '/v1/devices/register') result = await routes.register.POST(request)
      else if ((found = match(/^\/v1\/devices\/([^/]+)\/heartbeat$/))) result = await routes.heartbeat.POST(request, { params: Promise.resolve({ deviceId: found[0] }) })
      else if ((found = match(/^\/v1\/devices\/([^/]+)\/runs\/([^/]+)\/claim$/))) result = await routes.claim.POST(request, { params: Promise.resolve({ deviceId: found[0], runId: found[1] }) })
      else if ((found = match(/^\/v1\/runs\/([^/]+)\/checkpoint$/))) result = await routes.checkpoint.POST(request, { params: Promise.resolve({ runId: found[0] }) })
      else if ((found = match(/^\/v1\/runs\/([^/]+)\/complete$/))) result = await routes.complete.POST(request, { params: Promise.resolve({ runId: found[0] }) })
      else if (request.method === 'GET' && (found = match(/^\/api\/artifacts\/([^/]+)\/versions\/([^/]+)\/download$/))) {
        objectRequests.push(path)
        const [artifactId, version] = found
        result = await runRequestScope(createRequestScope(request), () => routes.artifact.GET(request, { params: Promise.resolve({ artifactId, version }) }))
      } else if (request.method === 'GET' && (found = match(/^\/api\/captures\/([^/]+)$/))) {
        objectRequests.push(path)
        const [captureId] = found
        result = await runRequestScope(createRequestScope(request), () => routes.capture.GET(request, { params: Promise.resolve({ captureId }) }))
      }
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
  ownedWorkspaces.push(workspace.id)
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
  const child = async (claimed: RunAssignment, bridge: TaskSecretBridge, endpoint?: { name: string; path: string }) => {
    const env = taskExecutionEnv({}, { taskEnv: claimed.taskEnv, taskSecretEnv: bridge.env })
    if (endpoint) { env.LOCAL_ENDPOINT_NAME = endpoint.name; env.LOCAL_ENDPOINT_PATH = endpoint.path }
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

  // Every stage is a new normal admission and HTTP claim on the existing Bot's
  // workspace. No run identity, Secret grant or capability is patched by SQL.
  let taskNumber = 1
  const freshClaim = async () => {
    const taskId = await seedIssue(pool, owner, workspace.id)
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [taskId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++taskNumber } } })])
    const next = await queueRun(owner, { issueId: taskId, agentId: b.agentId, repo: remote, model: 'fixture-model',
      modelDispatch: { mode: 'preference', routing: { version: 1, difficulty: 'hard', model: 'fixture-model', harness: 'claude_code', tier: 'standard', effort: 'high', reason: 'difficulty_fit' } } }, botId)
    const claimed = await b.link.claimRun(b.id, next.runId)
    const row = (await pool.query<{ workspaceId: string; principal: string; repository: string }>(
      `SELECT r."agentDefinition"->'executionIdentity'->>'workspaceId' AS "workspaceId",
        r."agentDefinition"->'executionIdentity'->>'executionPrincipal' AS principal, d."remoteUrl" AS repository
        FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r.id=$1 AND r."userId"=$2`, [claimed.runId, owner])).rows[0]
    assert.equal(row.workspaceId, workspace.id)
    assert.equal(row.principal, owner)
    assert.equal(row.repository, remote)
    return claimed
  }
  const complete = (claimed: RunAssignment) => b.link.completeRun(claimed.runId, { stopReason: 'cancelled',
    report: { summary: 'Local Secret scope fixture', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
  const assertJournalWithheld = async (claimed: RunAssignment, values: string[]) => {
    const path = join(directory, `runs-${claimed.runId}.json`), journal = new RunJournal(path)
    journal.put({ assignment: claimed, state: 'running', sessionId: null, worktree: null, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
    const raw = await readFile(path, 'utf8')
    assert.equal(values.some(value => raw.includes(value)) || raw.includes('synthetic-protected-') || raw.includes('mikka-egress-v1.'), false)
    const restored = new RunJournal(path).get(claimed.runId)
    assert.equal(restored?.taskSecretsWithheld, true)
    assert.equal(restored?.assignment.taskSecrets, undefined)
    assert.equal(restored?.assignment.taskEnv, undefined)
  }

  await t.test('fresh claims deliver workspace, matching repository, then personal precedence through real child TLS', async t => {
    const scopedName = 'SCOPED_PROTECTED_TOKEN'
    const delivery = { mode: 'protected', http: { origin: providerOrigin, header: 'authorization', prefix: 'Bearer ', rules: [{ method: 'GET', path: '/v1/scope', match: 'exact' }] } }
    const values = Array.from({ length: 3 }, () => 'synthetic-protected-' + randomBytes(24).toString('hex'))
    await shared.createWorkspaceSecret(owner, workspace.id, { name: scopedName, kind: 'secret', value: values[0], delivery })
    await shared.createWorkspaceSecret(owner, workspace.id, { name: 'OTHER_REPOSITORY_ONLY', kind: 'secret',
      value: 'synthetic-protected-' + randomBytes(24).toString('hex'), scope: { type: 'repository', repository: repository + '-other' }, delivery })
    for (const [index, label] of ['workspace', 'matching repository', 'personal override'].entries()) {
      await t.test(label, async () => {
        if (index === 1) await shared.createWorkspaceSecret(owner, workspace.id, { name: scopedName, kind: 'secret', value: values[index],
          scope: { type: 'repository', repository }, delivery })
        if (index === 2) await personal.createUserSecret(owner, { name: scopedName, kind: 'secret', value: values[index],
          overrideWorkspace: true, delivery }, { workspaceId: workspace.id })
        expectedScopedValue = values[index]
        const claimed = await freshClaim()
        assert.equal(claimed.taskSecrets?.grants.filter(grant => grant.name === scopedName).length, 1)
        assert.equal(claimed.taskSecrets?.grants.some(grant => grant.name === 'OTHER_REPOSITORY_ONLY'), false)
        assert.equal(claimed.taskSecrets?.unavailable.includes('OTHER_REPOSITORY_ONLY'), false)
        assert.equal(values.some(value => JSON.stringify(claimed).includes(value)), false)
        assert.equal(Object.hasOwn(claimed.taskEnv ?? {}, scopedName), false)
        const bridge = await startBridge(() => claimed.taskSecrets)
        const receipt = await child(claimed, bridge, { name: scopedName, path: '/v1/scope' })
        assert.equal(receipt.status, 200)
        assert.equal(receipt.bodyHash, createHash('sha256').update(responseBody).digest('hex'))
        await assertJournalWithheld(claimed, values)
        await complete(claimed)
        bridge.close()
      })
    }
    assert.equal(scopeRequests, 3)
    assert.equal(scopeDenied, 0, 'the TLS provider accepted the effective value in every actual claim')
  })

  let ownerCookie: string | undefined
  await t.test('only a fresh human approval enables direct delivery and real non-HTTP child signing', async () => {
    const directName = 'LOCAL_DIRECT_SIGNING_KEY', directValue = 'synthetic-direct-' + randomBytes(24).toString('hex')
    const secret = await personal.createUserSecret(owner, { name: directName, kind: 'secret', value: directValue }, {})
    const challenge = 'local-explicit-direct-hmac-fixture'
    const sign = async (claimed: RunAssignment) => {
      const bridge = await startBridge(() => claimed.taskSecrets)
      const env = taskExecutionEnv({}, { taskEnv: claimed.taskEnv, taskSecretEnv: bridge.env })
      const script = `const { createHmac } = require('node:crypto');
        const env = JSON.stringify(process.env), key = process.env.LOCAL_DIRECT_SIGNING_KEY;
        process.stdout.write(JSON.stringify({ available: typeof key === 'string',
          signature: typeof key === 'string' ? createHmac('sha256', key).update(process.env.LOCAL_SIGNING_CHALLENGE).digest('hex') : null,
          ordinaryEnv: process.env.LOCAL_FIXTURE_MODE === 'ordinary-env',
          protectedValueAbsent: !env.includes('synthetic-protected-'), rawCapabilityAbsent: !env.includes('mikka-egress-v1.'),
          controlCredentialsAbsent: !['WORKSPACE_SECRETS_KEY','BETTER_AUTH_SECRET','DATABASE_URL','MIKKA_DATABASE_URL','MIKKA_DEVICE_TOKEN'].some(k => k in process.env)
        }));`
      try {
        const result = await promisify(execFile)(process.execPath, ['-e', script], { cwd: directory,
          env: { ...env, LOCAL_SIGNING_CHALLENGE: challenge, NODE_ENV: 'test' }, timeout: 8_000, maxBuffer: 16_384 })
        assert.equal(result.stderr, '')
        const receipt = JSON.parse(result.stdout) as { available: boolean; signature: string | null; ordinaryEnv: boolean; protectedValueAbsent: boolean; rawCapabilityAbsent: boolean; controlCredentialsAbsent: boolean }
        assert.equal(receipt.ordinaryEnv && receipt.protectedValueAbsent && receipt.rawCapabilityAbsent && receipt.controlCredentialsAbsent, true)
        return receipt
      } finally { bridge.close() }
    }
    const before = await freshClaim()
    assert.equal(Object.hasOwn(before.taskEnv ?? {}, directName), false)
    assert.equal(before.taskSecrets?.unavailable.includes(directName), true)
    assert.equal(before.taskSecrets?.grants.some(grant => grant.name === directName), false)
    assert.equal(JSON.stringify(before).includes(directValue), false)
    const blocked = await sign(before)
    assert.equal(blocked.available, false)
    assert.equal(blocked.signature, null, 'an unconfigured protected Secret cannot silently become a signing key')
    await complete(before)

    // The same real Better Auth email-session fixture used by web handoff tests;
    // only this isolated, verified owner is signed in. No auth reader is mocked.
    const { auth } = await import('../lib/auth')
    const context = await auth.$context
    const password = randomBytes(32).toString('base64url')
    await context.internalAdapter.createAccount({ userId: owner, accountId: owner, providerId: 'credential', password: await context.password.hash(password) })
    const login = await auth.api.signInEmail({ body: { email: `${owner}@example.invalid`, password },
      headers: new Headers({ origin: new URL(context.baseURL).origin }), returnHeaders: true })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.equal(Boolean(cookie && login.response.token), true, 'actual owner sign-in produced a session')
    ownerCookie = cookie
    const approve = async (authorization?: string) => fetch(`${base}/api/secrets/delivery`, { method: 'PATCH',
      headers: { cookie, origin: base, 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) },
      body: JSON.stringify({ id: secret.id, delivery: { mode: 'direct', exposeToAgent: true } }) })
    const delegated = await approve(b.token)
    assert.equal(delegated.status, 401, 'a real device bearer cannot borrow the human cookie to approve plaintext')
    await delegated.arrayBuffer()
    assert.equal((await personal.listUserSecrets(owner)).find(row => row.id === secret.id)?.delivery?.mode, 'protected')
    const approved = await approve()
    assert.equal(approved.status, 200)
    const metadata = await approved.json() as { secret: { delivery: { mode: string; approvedBy: string; approvedAt: string } } }
    assert.equal(metadata.secret.delivery.mode, 'direct')
    assert.equal(metadata.secret.delivery.approvedBy, owner)
    assert.equal(Number.isFinite(Date.parse(metadata.secret.delivery.approvedAt)), true)
    assert.equal(JSON.stringify(metadata).includes(directValue) || Object.hasOwn(metadata.secret, 'value') || Object.hasOwn(metadata.secret, 'ciphertext'), false)

    const after = await freshClaim()
    assert.equal(after.taskEnv?.[directName] === directValue, true)
    assert.equal(after.taskSecrets?.unavailable.includes(directName), false)
    assert.equal(after.taskSecrets?.grants.some(grant => grant.name === directName), false)
    const signed = await sign(after)
    assert.equal(signed.available, true)
    assert.equal(signed.signature === createHmac('sha256', directValue).update(challenge).digest('hex'), true)
    await assertJournalWithheld(after, [directValue])
    await complete(after)
  })

  await t.test('the exact claimed Run collector executes every formal SQL category and normal owner download without holding a transaction', async () => {
    assert.ok(ownerCookie, 'reuse the real owner login; do not replace the authorization reader')
    const personalWorkspace = await seedPersonalWorkspace(pool, owner)
    if (!ownedWorkspaces.includes(personalWorkspace)) ownedWorkspaces.push(personalWorkspace)
    const claimed = await freshClaim()
    const claimedTask = (await pool.query<{ issueId: string }>('SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [claimed.runId, owner])).rows[0].issueId
    const scope: { ownerId: string; workspaceId: string; botId: string; issueId: string; runId: string } =
      { ownerId: owner, workspaceId: workspace.id, botId, issueId: claimedTask, runId: claimed.runId }
    const synthetic = Array.from({ length: 3 }, () => 'mikka1712s_' + randomBytes(32).toString('hex'))
    const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
    const canaries = { descriptor: { format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'] },
      generations: synthetic.map((value, index) => ({ generation: index + 1, sha256: digest(value), state: 'acknowledged' })) }

    // These are deliberately seeded evidence bodies, not model output. A real
    // claim/owner scope and the production persistence/download code stay in use.
    const chunks = [{ type: 'text-start', id: 'evidence-stream' },
      { type: 'text-delta', id: 'evidence-stream', delta: synthetic[0].slice(0, 31) },
      { type: 'text-delta', id: 'evidence-stream', delta: synthetic[0].slice(31) },
      { type: 'text-end', id: 'evidence-stream' }]
    const sequence = Number((await pool.query<{ next: number }>('SELECT COALESCE(max(seq),-1)+1 AS next FROM run_chunks WHERE "runId"=$1', [claimed.runId])).rows[0].next)
    for (const [index, chunk] of chunks.entries()) await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,$3,$4)',
      [randomUUID(), claimed.runId, sequence + index, JSON.stringify(chunk)])
    await pool.query('INSERT INTO run_messages (id,"runId","userId",text) VALUES ($1,$2,$3,$4)', [randomUUID(), claimed.runId, owner, synthetic[1]])
    const patch = gzipSync(`diff --git a/evidence.txt b/evidence.txt\n--- a/evidence.txt\n+++ b/evidence.txt\n@@ -0,0 +1 @@\n+${synthetic[2]}\n`)
    assert.equal((await b.link.checkpointRun(claimed.runId, { baseCommit: 'a'.repeat(40), patch: patch.toString('base64'), files: 1,
      takenAt: new Date().toISOString() }))?.runId, claimed.runId)

    const { artifactStorage } = await import('../lib/artifacts/storage')
    const { submitArtifact } = await import('../lib/artifacts/store')
    const captures = await import('../lib/captures/store')
    assert.equal(artifactStorage(), 'inline', 'this fixture cannot contact a bucket')
    const first = await submitArtifact({ userId: owner, workspaceId: workspace.id, botId, runId, issueId, authorName: 'Fixture Agent' },
      { title: 'Evidence versions', kind: 'markdown', content: '# Original\nNot submitted by the collected Run.\n' })
    assert.ok(!('error' in first))
    for (const [index, content] of ['# Version two\nClean controlled body.\n', '# Version three\n' + synthetic[0]].entries()) {
      const version = await submitArtifact({ userId: owner, workspaceId: workspace.id, botId, runId: claimed.runId, issueId: claimedTask, authorName: 'Fixture Agent' },
        { artifactId: first.artifactId, title: 'Evidence versions', kind: 'markdown', content })
      assert.ok(!('error' in version)); assert.equal(version.version, index + 2)
    }
    assert.deepEqual((await pool.query<{ runId: string; latestVersion: number }>('SELECT "runId","latestVersion" FROM artifacts WHERE id=$1', [first.artifactId])).rows[0],
      { runId, latestVersion: 3 }, 'creator and latest pointer cannot replace per-version submission provenance')
    const captureOwner = { userId: owner, runId: claimed.runId, issueId: claimedTask, botId }
    const recording = await captures.openRecording(captureOwner, { title: 'Controlled evidence bytes', display: 1, stopsAt: new Date(Date.now() + 60_000) })
    assert.ok(recording)
    await captures.markRecordingStarted(recording.id)
    assert.equal(await captures.recordStep(captureOwner, { label: synthetic[1], source: 'mark' }), true)
    const recordingRow = await captures.currentRecording(claimed.runId)
    assert.ok(recordingRow)
    // A protocol-recognized byte fixture exercises storage and HTTP transport;
    // it is not a rendered screen recording and cannot prove visual absence.
    const media = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypisom-evidence-fixture')])
    const ready = await captures.finishRecording(recordingRow, { bytes: media, durationMs: 1 })
    assert.ok(!('error' in ready))
    await complete(claimed)

    type ObjectReceipt = { category: string; id: string; inventoryStable: boolean; inventoryStatus: string;
      attributes: { version?: number }; content: null | { verified: boolean; bytes: number; sha256: string };
      scan: { status: string; matchedGenerations: number[]; reasons: string[] }; inflated?: { bytes: number; sha256: string } }
    type EvidenceReceipt = { status: string; inventoryStable: boolean; objects: ObjectReceipt[]; reasons: string[];
      categories: Record<string, { status: string; observed: number; scan: string }>;
      serverEvidence: { status: string }; vmTranscript: { status: string } }
    type QueryOptions = { signal: AbortSignal; timeoutMs: number }
    const evidenceModule = new URL('../scripts/acceptance/task-secrets-evidence.mjs', import.meta.url).href
    const { collectTaskSecretEvidence } = await import(evidenceModule) as { collectTaskSecretEvidence(input: {
      query(sql: string, values: unknown[], options: QueryOptions): Promise<{ rows: unknown[] }>;
      client: { request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> };
      scope: typeof scope; canaries: typeof canaries; budget: { remaining(phase: string, maximum: number): number; signal(): AbortSignal };
      saveObject(object: ObjectReceipt): Promise<void>; limits: { pageSize: number; pagesPerCategory: number };
    }): Promise<EvidenceReceipt> }
    const statements = new Set<string>(), persisted = new Map<string, ObjectReceipt>()
    const writes: Array<{ key: string; status: string }> = []
    const objectKey = (object: ObjectReceipt) => `${object.category}:${object.id}`
    let openTransactions = 0
    const query = async (sql: string, values: unknown[], { signal, timeoutMs }: QueryOptions) => {
      const label = /^\/\* task-secret-evidence:([a-z_]+) \*\//.exec(sql)?.[1]
      assert.ok(label); statements.add(label)
      assert.ok(timeoutMs > 0 && timeoutMs <= 5000); signal.throwIfAborted()
      const connection = await pool.connect()
      let begun = false, released = false
      const abort = () => { if (!released) { released = true; connection.release(true) } }
      signal.addEventListener('abort', abort, { once: true })
      openTransactions++
      try {
        signal.throwIfAborted()
        await connection.query('BEGIN READ ONLY'); begun = true
        await connection.query('SELECT set_config(\'statement_timeout\',$1,true)', [String(Math.floor(timeoutMs))])
        const result = await connection.query(sql, values)
        signal.throwIfAborted(); await connection.query('COMMIT'); begun = false
        return { rows: result.rows as unknown[] }
      } finally {
        signal.removeEventListener('abort', abort)
        try { if (begun && !released) await connection.query('ROLLBACK') }
        finally { if (!released) connection.release(); openTransactions-- }
      }
    }
    const evidenceSignal = AbortSignal.timeout(20_000)
    const deadline = Date.now() + 20_000
    const budget = { remaining: (phase: string, maximum: number) => {
      assert.equal(phase, 'evidence'); evidenceSignal.throwIfAborted()
      const remaining = Math.min(maximum, deadline - Date.now()); assert.ok(remaining > 0); return remaining
    }, signal: () => evidenceSignal }
    const client = { request: async (path: string, init: RequestInit, timeoutMs: number) => {
      assert.equal(openTransactions, 0, 'all database leases are released before normal HTTP I/O')
      const headers = new Headers(init.headers); headers.set('cookie', ownerCookie!)
      assert.equal(headers.get('x-mikka-workspace-id'), workspace.id)
      return fetch(new URL(path, base), { ...init, headers, redirect: 'error',
        signal: AbortSignal.any([evidenceSignal, AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]) })
    } }
    const collect = (selected = scope) => collectTaskSecretEvidence({ query, client, scope: selected, canaries, budget,
      saveObject: async object => {
        const key = objectKey(object), previous = persisted.get(key)
        if (object.inventoryStatus === 'pending_verification') {
          assert.equal(previous, undefined)
          assert.equal(object.inventoryStable, false)
        } else assert.equal(previous?.inventoryStatus, 'pending_verification')
        const path = join(directory, `evidence-${object.category}-${object.id}.json`)
        await writeFile(path, JSON.stringify(object), { mode: 0o600 })
        const stored = JSON.parse(await readFile(path, 'utf8')) as ObjectReceipt
        assert.deepEqual(stored, object, 'each pending and final receipt reaches private storage before the next read')
        persisted.set(key, stored)
        writes.push({ key, status: stored.inventoryStatus })
      }, limits: { pageSize: 1, pagesPerCategory: 32 } })
    const receipt = await collect()
    assert.equal(receipt.inventoryStable, true)
    assert.deepEqual([...statements].sort(), ['scope', 'chunks', 'messages', 'checkpoint', 'artifact_versions', 'captures', 'capture_steps', 'run_definition'].sort())
    assert.ok(Object.values(receipt.categories).every(category => category.observed > 0 && category.status === 'collected'))
    assert.equal(receipt.status, 'leak_detected', 'known positive controls cannot be reported as an empty negative')
    const matches = (category: string, generation: number) => receipt.objects.some(object => object.category === category && object.scan.matchedGenerations.includes(generation))
    assert.equal(matches('chunks', 1), true, 'the marker is split across two real SQL pages')
    assert.equal(matches('messages', 2), true)
    assert.equal(matches('checkpoint', 3), true)
    assert.equal(matches('artifact_versions', 1), true, 'downloaded v3 content is scanned through the actual owner route')
    assert.equal(matches('capture_steps', 2), true)
    assert.ok(receipt.objects.find(object => object.category === 'checkpoint')?.inflated?.bytes)
    const versions = receipt.objects.filter(object => object.category === 'artifact_versions')
    assert.deepEqual(versions.map(object => object.attributes.version).sort(), [2, 3])
    assert.ok(versions.every(object => object.content?.verified))
    const capture = receipt.objects.find(object => object.category === 'captures')
    assert.equal(capture?.content?.verified, true)
    assert.ok(capture?.scan.reasons.includes('visual_content_unscanned'))
    assert.equal(receipt.serverEvidence.status, 'incomplete'); assert.equal(receipt.vmTranscript.status, 'needs_collection')
    assert.equal(persisted.size, receipt.objects.length)
    assert.ok(writes.some(write => write.status === 'pending_verification'))
    for (const object of receipt.objects) {
      assert.deepEqual(writes.filter(write => write.key === objectKey(object)).map(write => write.status), ['pending_verification', 'verified'])
      assert.deepEqual(persisted.get(objectKey(object)), object, 'the final receipt replaces the pending receipt under the same key')
    }
    assert.equal(synthetic.some(value => JSON.stringify({ receipt, persisted: [...persisted.values()] }).includes(value)), false)
    assert.deepEqual([...objectRequests].sort(), [`/api/artifacts/${first.artifactId}/versions/2/download`,
      `/api/artifacts/${first.artifactId}/versions/3/download`, `/api/captures/${recording.id}`].sort())

    for (const selected of [{ ...scope, ownerId: outsider }, { ...scope, workspaceId: personalWorkspace }]) {
      const reads = objectRequests.length, savedObjects = persisted.size, savedWrites = writes.length
      const denied = await collect(selected)
      assert.equal(denied.inventoryStable, false); assert.ok(denied.reasons.includes('scope_unverified'))
      assert.equal(denied.objects.length, 0); assert.equal(objectRequests.length, reads); assert.equal(persisted.size, savedObjects)
      assert.equal(writes.length, savedWrites)
    }
    await assert.rejects(pool.query('UPDATE run_checkpoints SET patch=NULL WHERE "runId"=$1', [claimed.runId]),
      error => (error as { code?: string }).code === '23502')
    assert.equal((await pool.query<{ digest: string }>('SELECT encode(sha256(patch),\'hex\') AS digest FROM run_checkpoints WHERE "runId"=$1', [claimed.runId])).rows[0].digest, digest(patch),
      'formal NOT NULL rejection retains the actual gzip bytes; no test-only schema relaxation')
    assert.equal(openTransactions, 0)
  })
  assert.deepEqual(routeErrors, [])
  assert.equal(upstreamRequests, 2, 'direct HMAC uses no HTTP endpoint and scope tests use their separate TLS path')
  assert.equal(scopeRequests, 3)
})
