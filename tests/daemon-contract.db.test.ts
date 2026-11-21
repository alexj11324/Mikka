// The released daemon recorded as MIN_DAEMON_VERSION (packages/daemon/test/fixtures/released-<version>/)
// against today's device routes. Decision 2026-11-17-2215: a daemon is usable
// only while it holds its device session, and one that does not send the device
// session header gets 426 on every device route, with no grace (#1023's
// contract becomes "refused, told to update"). Once MIN_DAEMON_VERSION names a
// release that holds a session, its recorded client is served again here.
// Real PostgreSQL and the real routes; only Next's `after` is replaced.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MIN_DAEMON_VERSION } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'
import { DAEMON_FIXTURE } from './support/daemon-fixture'

type ReleasedLink = {
  registerDevice(credential: string, info: unknown, knownDeviceId?: string): Promise<{ deviceId: string }>
  heartbeat(deviceId: string, status: unknown): Promise<{ leases: Record<string, string> }>
  listRepos(deviceId: string): Promise<{ repoId: string; path: string; name: string; remoteUrl?: string | null }[]>
  pendingRuns(deviceId: string): Promise<string[]>
  claimRun(deviceId: string, runId: string): Promise<{ runId: string; remoteUrl?: string }>
}

test(`daemon ${MIN_DAEMON_VERSION} as released, without a device session, is told to update on every device route`, { skip: !dbUrl }, async t => {
  // The released daemon asks for a signed policy snapshot; a synthetic secret signs it here.
  const savedSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString('hex')
  t.after(() => { if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = savedSecret })
  const next = await import('@/lib/server-runtime/server')
  mock.module('@/lib/server-runtime/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueRun } = await import('../lib/agent-runs')
  const { hashDeviceToken } = await import('../lib/device-link')
  const routes = {
    register: await import('../app/v1/devices/register/route'),
    report: await import('../app/v1/devices/[deviceId]/report/route'),
    repos: await import('../app/v1/devices/[deviceId]/repos/route'),
    runs: await import('../app/v1/devices/[deviceId]/runs/route'),
    claim: await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route'),
  }
  const { HttpServerLink } = await import(join(DAEMON_FIXTURE, 'http-link.js')) as { HttpServerLink: new (base: string, fetcher: typeof fetch, version: string) => ReleasedLink }

  const owner = await seedUser(pool, 'daemon-contract')
  t.after(async () => {
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
    for (const table of ['agent_runs', 'agents', 'device_repos']) await pool.query(`DELETE FROM ${table} WHERE "userId"=$1`, [owner])
    await pool.query('DELETE FROM device_tokens WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const botId = await seedBot(pool, ws.id, owner)
  const issueId = await seedIssue(pool, owner, ws.id)
  const remote = `https://github.com/mikka-ci/daemon-contract-${randomUUID()}.git`
  await recordPushGrant(pool, owner, normalizeRepository(remote).key)
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
  const harnesses = [{ harness: 'claude_code', installed: true, version: '2.1.0', toolApproval: true }]
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"daemonVersion","protocolVersion","lastSeenAt",harnesses,"sessionOpenedAt") VALUES ($1,$2,'Laptop','local',true,$3,$4,now(),$5,now())`,
    [deviceId, owner, MIN_DAEMON_VERSION, DAEMON_PROTOCOL_VERSION, JSON.stringify(harnesses)])
  await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, owner, deviceId, `claude_code-${agentId.slice(0, 8)}`])
  await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, owner, normalizeRepository(remote).key, remote])
  const token = `synthetic-${randomUUID()}`
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), owner, hashDeviceToken(token)])

  const statuses: number[] = []
  /** Today's route handlers behind the released client's fetch. */
  const serve = (async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const match = (pattern: RegExp) => path.match(pattern)?.slice(1)
    let found: string[] | undefined
    let response: Response
    if (path === '/v1/devices/register') response = await routes.register.POST(request)
    else if ((found = match(/^\/v1\/devices\/([^/]+)\/report$/))) response = await routes.report.POST(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    else if ((found = match(/^\/v1\/devices\/([^/]+)\/repos$/))) response = await routes.repos.GET(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    else if ((found = match(/^\/v1\/devices\/([^/]+)\/runs$/))) response = await routes.runs.GET(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    else if ((found = match(/^\/v1\/devices\/([^/]+)\/runs\/([^/]+)\/claim$/))) response = await routes.claim.POST(request, { params: Promise.resolve({ deviceId: found[0]!, runId: found[1]! }) })
    else response = new Response(null, { status: 404 })
    statuses.push(response.status)
    return response
  }) as typeof fetch
  const link = new HttpServerLink('http://127.0.0.1', serve, MIN_DAEMON_VERSION)

  const { runId } = await queueRun(owner, { issueId, agentId, repo: remote, model: 'fixture-model',
    modelDispatch: { mode: 'preference', routing: { version: 1, difficulty: 'hard', model: 'fixture-model', harness: 'claude_code', tier: 'standard', effort: 'high', reason: 'difficulty_fit' } } }, botId)
  await assert.rejects(link.registerDevice(token, { name: 'Laptop', platform: 'linux', arch: 'x64', daemonVersion: MIN_DAEMON_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION, harnesses }, deviceId))
  await assert.rejects(link.listRepos(deviceId))
  await assert.rejects(link.pendingRuns(deviceId))
  await assert.rejects(link.claimRun(deviceId, runId))
  await assert.rejects(link.heartbeat(deviceId, { harnesses, runs: [], worktreeDiskBytes: 0 }), 'the heartbeat route is gone')
  assert.deepEqual(statuses, [426, 426, 426, 426, 404], 'every device route tells the released daemon to update; nothing is served')
  assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'queued', 'the run is not claimed')
})
