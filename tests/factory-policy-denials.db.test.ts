import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { remoteKey } from '@mikka/protocol/repository'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated Factory policy database is required')
let actor = '', sessionId = randomUUID()
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
  getSession: async () => ({ user: { id: actor }, session: { id: sessionId } }),
} } } })
const next = await import('next/server')
// Node has no Next request-lifetime scheduler. Response handling, device auth,
// Factory/policy services and all database operations remain real.
mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })

test('Factory task denials preserve public errors before policy and execution side effects', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const owner = `factory576-${randomUUID()}`, other = `factory576-other-${randomUUID()}`
  actor = owner
  const previous = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
  process.env.MIKKA_FACTORY_ROUTING_ENABLED = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
  const tokenId = randomUUID(), token = randomUUID(), deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID()
  t.after(async () => {
    try { await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId]) }
    finally {
      if (previous.routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = previous.routing
      if (previous.lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = previous.lifecycle
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
    }
  })
  for (const id of [owner, other]) await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
  const remoteUrl = `https://github.com/mikka-ci/factory-policy-${repoId}.git`
  await pool.query('INSERT INTO devices (id,"ownerId",name,"protocolVersion",harnesses) VALUES ($1,$2,\'Factory policy fixture\',$3,$4)', [deviceId, owner, DAEMON_PROTOCOL_VERSION, JSON.stringify([{ harness: 'codex', installed: true, toolApproval: true }])])
  await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [tokenId, owner, createHash('sha256').update(token).digest('hex')])
  await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, owner, remoteKey(remoteUrl), remoteUrl])
  await pool.query('INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,\'Factory policy fixture\',\'codex\',$3)', [agentId, owner, deviceId])
  const { factoryStore, factoryQuestions, questionSkillAssignments } = await import('../lib/factory/server')
  const { questionReference } = await import('../lib/factory/questions/store')
  const questionRoute = await import('../app/api/factory/questions/[questionId]/route')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  async function fixture(question = false, workspace = false) {
    const issueId = randomUUID(), eventId = randomUUID(), runId = randomUUID(), questionId = randomUUID()
    let workspaceId: string | undefined
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Factory policy fixture\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\',$3)', [issueId, workspace ? other : owner, workspace ? 'workspace' : 'personal'])
    if (workspace) {
      workspaceId = randomUUID()
      const team = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,\'Factory policy fixture\')', [workspaceId, owner])
      await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, owner, `${owner}@example.invalid`])
      await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspaceId, other, `${other}@example.invalid`])
      await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,\'Factory policy fixture\',\'FP576\')', [team, workspaceId, owner])
      await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issueId, team, workspaceId, other])
    }
    await pool.query('INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1::uuid,$2,\'user_message\',$1::text,$3,\'{"text":"Factory policy fixture"}\')', [eventId, owner, issueId])
    const routed = await factoryStore.route(owner, { issueId, eventId: randomUUID(), sourceEventId: eventId, rationale: 'Explicit fixture', needsSpec: true })
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,kind,prompt,"stopReason","sessionId",report) VALUES ($1,$2,$3,$4,$5,$6,$7,\'plan\',\'private-factory-prompt\',$8,$9,$10)', [runId, owner, issueId, agentId, deviceId, repoId, question ? 'stopped' : 'queued', question ? 'asked_human' : null, question ? `fixture:${runId}` : null, question ? JSON.stringify({ question: { questionId, kind: 'decision', question: 'Which API?', options: [] } }) : null])
    await pool.query('UPDATE factory_tasks SET status=\'running\' WHERE id=$1', [routed.task.id])
    await pool.query('UPDATE factory_attempts SET status=\'running\',"runId"=$2 WHERE id=$1', [routed.task.attemptId, runId])
    const q = question ? await factoryQuestions.record(owner, runId) : undefined
    return { issueId, runId, workspaceId, q }
  }
  const answer = async (f: Awaited<ReturnType<typeof fixture>>, origin = 'http://127.0.0.1') => {
    const id = f.q!.id
    return questionRoute.POST(new Request(`http://127.0.0.1/api/factory/questions/${id}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ reference: questionReference(f.q!), answerId: randomUUID(), text: 'Continue' }) }), { params: Promise.resolve({ questionId: id }) })
  }
  await t.test('deleted questions return factoryNotFound and cannot create a continuation', async () => {
    const f = await fixture(true)
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); await questionSkillAssignments.lockAnswer!(owner, f.q!.id, tx) }
    finally { await tx.query('ROLLBACK'); tx.release() }
    await pool.query('UPDATE issues SET content=\'{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}\' WHERE id=$1', [f.issueId])
    const response = await answer(f)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'factoryNotFound' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT "continuationRunId" FROM factory_questions WHERE id=$1', [f.q!.id])).rows[0].continuationRunId, null)
  })
  await t.test('workspace removal, expired questions and Origin retain their existing denials', async () => {
    const scoped = await fixture(true, true)
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [scoped.workspaceId, owner])
    assert.equal((await answer(scoped)).status, 404)
    const expired = await fixture(true)
    await pool.query('UPDATE factory_questions SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [expired.q!.id])
    const response = await answer(expired)
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'factoryQuestionExpired' })
    assert.equal((await answer(expired, 'https://untrusted.invalid')).status, 403)
  })
  await t.test('revoked personal/workspace claims keep issue_unavailable with zero issuance and queued state', async () => {
    for (const workspace of [false, true]) {
      const f = await fixture(false, workspace)
      if (workspace) await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [f.workspaceId, owner])
      else await pool.query('UPDATE issues SET "userId"=$2 WHERE id=$1', [f.issueId, other])
      const response = await claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${deviceId}/runs/${f.runId}/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: '1', [SKILL_ARTIFACT_HEADER]: '1' } }), { params: Promise.resolve({ deviceId, runId: f.runId }) })
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), { error: 'The task is no longer available to this thread.', code: 'issue_unavailable' }, workspace ? 'workspace membership revoked' : 'personal owner changed')
      assert.deepEqual((await pool.query('SELECT status,"leaseExpiresAt" FROM agent_runs WHERE id=$1', [f.runId])).rows[0], { status: 'queued', leaseExpiresAt: null })
      for (const table of ['run_tokens', 'improvement_skill_receipts', 'run_publications']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE "runId"=$1`, [f.runId])).rows[0].n, 0)
    }
  })
  await t.test('unrelated database errors remain errors rather than becoming false notFound responses', async () => {
    const fault = new Error('synthetic database fault')
    let calls = 0
    const tx = { async query() { if (++calls === 1) return { rows: [{ originRunId: randomUUID() }] }; throw fault } } as unknown as PoolClient
    await assert.rejects(questionSkillAssignments.lockAnswer!(owner, randomUUID(), tx), error => error === fault)
  })
})
