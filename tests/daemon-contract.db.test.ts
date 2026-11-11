// The oldest daemon the server serves (MIN_DAEMON_VERSION), as released, talks to
// today's device routes: its HTTP client (packages/daemon/test/fixtures/released-<version>/, parsed
// with that release's own schemas) registers, heartbeats, lists repositories and
// queued runs, and claims one. A route answer that drops or reshapes a field the
// released daemon needs fails here before it reaches people's machines (#1023).
// Real PostgreSQL and the real routes; only Next's `after` is replaced.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MIN_DAEMON_VERSION, runAssignmentSchema } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'
import { DAEMON_FIXTURE } from './support/daemon-fixture'

type ReleasedLink = {
  registerDevice(credential: string, info: unknown, knownDeviceId?: string): Promise<{ deviceId: string }>
  heartbeat(deviceId: string, status: unknown): Promise<{ leases: Record<string, string> }>
  listRepos(deviceId: string): Promise<{ repoId: string }[]>
  pendingRuns(deviceId: string): Promise<string[]>
  claimRun(deviceId: string, runId: string): Promise<{ runId: string; remoteUrl?: string }>
}

test(`daemon ${MIN_DAEMON_VERSION} as released works against today's device routes`, { skip: !dbUrl }, async t => {
  // The released daemon asks for a signed policy snapshot; a synthetic secret signs it here.
  const savedSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString('hex')
  t.after(() => { if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = savedSecret })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueRun } = await import('../lib/agent-runs')
  const { hashDeviceToken } = await import('../lib/device-link')
  const routes = {
    register: await import('../app/v1/devices/register/route'),
    heartbeat: await import('../app/v1/devices/[deviceId]/heartbeat/route'),
    repos: await import('../app/v1/devices/[deviceId]/repos/route'),
    runs: await import('../app/v1/devices/[deviceId]/runs/route'),
    claim: await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route'),
  }
  const { HttpServerLink } = await import(join(DAEMON_FIXTURE, 'http-link.js')) as { HttpServerLink: new (base: string, fetcher: typeof fetch, version: string) => ReleasedLink }

  const owner = await seedUser(pool, 'daemon-contract')
  t.after(async () => {
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId"=$1', [owner]).catch(() => undefined)
    for (const table of ['agent_runs', 'agents', 'device_repos']) await pool.query(`DELETE FROM ${table} WHERE "userId"=$1`, [owner])
    await pool.query('DELETE FROM device_tokens WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM repository_settings WHERE "userId"=$1', [owner])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const botId = await seedBot(pool, ws.id, owner)
  const issueId = await seedIssue(pool, owner, ws.id)
  await pool.query(`UPDATE issues SET content=$2 WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1e6) + 1 } } })])
  const remote = `https://github.com/mikka-ci/daemon-contract-${randomUUID()}.git`
  await recordPushGrant(pool, owner, normalizeRepository(remote).key)
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
  const harnesses = [{ harness: 'claude_code', installed: true, version: '2.1.0', toolApproval: true }]
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"daemonVersion","protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Laptop','local',true,$3,$4,now(),$5)`,
    [deviceId, owner, MIN_DAEMON_VERSION, DAEMON_PROTOCOL_VERSION, JSON.stringify(harnesses)])
  await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, owner, deviceId, `claude_code-${agentId.slice(0, 8)}`])
  await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, owner, normalizeRepository(remote).key, remote])
  const token = `synthetic-${randomUUID()}`
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), owner, hashDeviceToken(token)])

  let claimPayload: unknown
  /** Today's route handlers behind the released client's fetch. */
  const serve = (async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    const match = (pattern: RegExp) => path.match(pattern)?.slice(1)
    let found: string[] | undefined
    if (path === '/v1/devices/register') return routes.register.POST(request)
    if ((found = match(/^\/v1\/devices\/([^/]+)\/heartbeat$/))) return routes.heartbeat.POST(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    if ((found = match(/^\/v1\/devices\/([^/]+)\/repos$/))) return routes.repos.GET(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    if ((found = match(/^\/v1\/devices\/([^/]+)\/runs$/))) return routes.runs.GET(request, { params: Promise.resolve({ deviceId: found[0]! }) })
    if ((found = match(/^\/v1\/devices\/([^/]+)\/runs\/([^/]+)\/claim$/))) {
      const response = await routes.claim.POST(request, { params: Promise.resolve({ deviceId: found[0]!, runId: found[1]! }) })
      if (response.ok) claimPayload = await response.clone().json()
      return response
    }
    throw new Error(`The contract test does not serve ${request.method} ${path}`)
  }) as typeof fetch
  const link = new HttpServerLink('http://127.0.0.1', serve, MIN_DAEMON_VERSION)

  const registered = await link.registerDevice(token, { name: 'Laptop', platform: 'linux', arch: 'x64', daemonVersion: MIN_DAEMON_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION, harnesses }, deviceId)
  assert.equal(registered.deviceId, deviceId)
  assert.deepEqual((await link.heartbeat(deviceId, { harnesses, runs: [], worktreeDiskBytes: 0 })).leases, {})
  assert.ok((await link.listRepos(deviceId)).some(repo => repo.repoId === repoId))

  const { runId } = await queueRun(owner, { issueId, agentId, repo: remote, model: 'fixture-model',
    modelDispatch: { mode: 'preference', routing: { version: 1, difficulty: 'hard', model: 'fixture-model', harness: 'claude_code', tier: 'standard', effort: 'high', reason: 'difficulty_fit' } } }, botId)
  assert.deepEqual(await link.pendingRuns(deviceId), [runId])
  const assignment = await link.claimRun(deviceId, runId)
  assert.equal(assignment.runId, runId)
  assert.equal(assignment.remoteUrl, remote)
  // The oldest supported client strips additive fields; current clients keep
  // the exact effort on the same wire response without breaking that client.
  assert.equal(runAssignmentSchema.parse(claimPayload).effort, 'high', 'the current protocol retains the host-frozen routing effort')
  const leased = await link.heartbeat(deviceId, { harnesses, runs: [{ runId, lastProgressAt: new Date().toISOString() }], worktreeDiskBytes: 0 })
  assert.ok(leased.leases[runId], 'the claimed run\'s lease is renewed')
})
