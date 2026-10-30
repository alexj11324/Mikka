import './fixtures/activity-runtime.mjs'
import { strict as assert } from 'node:assert'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from './helpers/e2e-target.mjs'

const target = process.env.CI_CHAIN_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (!target && process.env.REQUIRE_DB === '1') throw new Error('CI full-chain database fixture is required')
if (target && !isE2eTarget(target)) throw new Error(E2E_DB_RULE)

test('isolated PG: signed webhook schedules, snapshot settles, real admission queues and claim binds the original session', { skip: !target, timeout: 90_000 }, async () => {
  const schema = `ci_full_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const fixtureURL = new URL(target!)
  fixtureURL.searchParams.set('options', `-c search_path=${schema}`)
  const databaseURL = fixtureURL.toString()
  const fixture = new Pool({ connectionString: databaseURL, max: 10 })
  const previous = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID: process.env.GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY, NODE_ENV: process.env.NODE_ENV, MIKKA_CI_RESUME_ENABLED: process.env.MIKKA_CI_RESUME_ENABLED }
  const originalFetch = globalThis.fetch
  process.env.MIKKA_DATABASE_URL = databaseURL
  process.env.DATABASE_URL = databaseURL
  process.env.GITHUB_WEBHOOK_SECRET = 'isolated-ci-webhook-secret'
  process.env.GITHUB_APP_ID = '123'
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  Object.assign(process.env, { NODE_ENV: 'test' })
  delete process.env.MIKKA_CI_RESUME_ENABLED
  let scopedPool: Pool | undefined, workspacePool: Pool | undefined
  try {
    assert.equal((await fixture.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    const migrations = new URL('../drizzle/', import.meta.url)
    // This fixture skips only the unrelated global pg_trgm search index migration:
    // CREATE EXTENSION is database-global and outside its private schema.
    for (const name of orderMigrations((await readdir(migrations)).filter(n => n.endsWith('.sql') && !['20261026013000_issue_search_pg_trgm.sql', '20261026013001_issue_search_title_idx.sql'].includes(n)))) await fixture.query(await readFile(new URL(name, migrations), 'utf8'))
    const owner = `fixture-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID()
    const remoteKey = 'v2/github.com/acme/repo', remoteUrl = 'https://github.com/acme/repo.git'
    const sha = 'a'.repeat(40), branch = 'mikka/test-1', prUrl = 'https://github.com/acme/repo/pull/7'
    await fixture.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
    await fixture.query(`INSERT INTO account (id,"userId","providerId","accountId","createdAt","updatedAt") VALUES ($1,$2,'github','1234',now(),now())`, [randomUUID(), owner])
    await fixture.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture','local',true,now(),'[{"harness":"codex","installed":true,"toolApproval":true}]')`, [deviceId, owner])
    await fixture.query(`INSERT INTO agents (id,"userId","deviceId",harness,name,instructions) VALUES ($1,$2,$3,'codex','Fixture','')`, [agentId, owner, deviceId])
    await fixture.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Fixture task',$3,'todo','normal','personal')`, [issueId, owner, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    await fixture.query(`INSERT INTO issue_prefixes ("userId",prefix) VALUES ($1,'TEST')`, [owner])
    await fixture.query(`INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)`, [owner, remoteKey, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: new Date().toISOString() })])
    await fixture.query(`INSERT INTO github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES ($1,$2,'1234',55,77)`, [owner, remoteKey])
    const { queueRun } = await import('../lib/agent-runs')
    const { db, pool } = await import('../lib/db')
    const ws = await import('../lib/workspace-db')
    scopedPool = pool
    workspacePool = ws.workspacePool
    const { runId } = await queueRun(owner, { issueId, agentId, repo: remoteUrl })
    const original = await fixture.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])
    assert.ok(original.rows[0].agentDefinition.repositoryAdmission)
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='synthetic-original-session',"finishedAt"=now() WHERE id=$1`, [runId])
    await fixture.query(`UPDATE run_publications SET status='published',"pullRequest"=$2 WHERE "runId"=$1`, [runId, JSON.stringify({ url: prUrl, state: 'open' })])
    const { registerCiPublication } = await import('../lib/github/ci/register')
    await db.transaction(tx => registerCiPublication(tx, { userId: owner, issueId, remoteKey, runId, scopeVersion: 1, url: prUrl, state: 'open' }))
    let providerHead = sha
    let providerOpen = true
    let providerConclusion = 'failure'
    const checkRunId = 101
    let providerStatus = 'in_progress'
    // Exercise webhook recovery for publications that predate this feature.
    await fixture.query('DELETE FROM github_ci_observations')
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/repos/acme/repo/installation') return Response.json({ id: 55, suspended_at: null, permissions: { pull_requests: 'write', contents: 'read' } })
      if (path === '/app/installations/55/access_tokens') return Response.json({ token: 'isolated-token' })
      if (path === '/user/1234') return Response.json({ id: 1234, login: 'fixture' })
      if (path === '/repos/acme/repo/collaborators/fixture/permission') return Response.json({ permission: 'write', user: { id: 1234, login: 'fixture' } })
      if (path === '/repos/acme/repo') return Response.json({ id: 77, full_name: 'acme/repo', default_branch: 'main' })
      if (path === '/repos/acme/repo/pulls/7') return Response.json({ state: providerOpen ? 'open' : 'closed', head: { sha: providerHead, ref: branch, repo: { id: 77 } }, base: { repo: { id: 77 } } })
      if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ id: checkRunId, name: 'build', status: providerStatus, conclusion: providerStatus === 'completed' ? providerConclusion : null }] })
      if (path.endsWith('/status')) return Response.json({ total_count: 0, statuses: [] })
      throw Error(`unexpected fixture API path ${path}`)
    }
    const { POST } = await import('../app/api/webhooks/github/route')
    const eventBody = (attempt = 1) => JSON.stringify({ action: 'completed', repository: { id: 77 }, installation: { id: 55 }, workflow_run: { id: 1000, run_attempt: attempt, head_sha: sha, head_branch: branch } })
    const body = eventBody()
    const signed = (attempt = 1) => {
      const raw = eventBody(attempt)
      return new Request('http://localhost/api/webhooks/github', { method: 'POST', body: raw, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(raw).digest('hex')}` } })
    }
    const invalid = new Request('http://localhost/api/webhooks/github', { method: 'POST', body, headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': 'sha256=wrong' } })
    // Flag off (default): a signed CI event is acknowledged exactly as before
    // and writes nothing, although a matching publication receipt exists.
    assert.equal((await POST(signed())).status, 202)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM github_ci_observations')).rows[0].n, 0)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM github_ci_workflow_attempts')).rows[0].n, 0)
    process.env.MIKKA_CI_RESUME_ENABLED = '1'
    assert.equal((await POST(invalid)).status, 401)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM github_ci_observations')).rows[0].n, 0)
    assert.equal((await POST(signed())).status, 202)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM github_ci_observations')).rows[0].n, 1)
    assert.equal((await POST(signed())).status, 202)
    const { reconcileCi } = await import('../lib/github/ci/reconcile')
    const pending = await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })
    assert.equal(pending.pending, 1)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs WHERE "ciContinuation" IS NOT NULL')).rows[0].n, 0)
    providerStatus = 'completed'
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    const first = await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })
    assert.equal(first.pending, 1)
    assert.equal((await fixture.query('SELECT count(*)::int n FROM agent_runs WHERE "ciContinuation" IS NOT NULL')).rows[0].n, 0)
    await fixture.query(`UPDATE github_ci_observations SET "firstSeenAt"=now()-interval '5 minutes',"nextCheckAt"=now()`)
    const results = await Promise.all([reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 }), reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })])
    assert.equal(results.reduce((sum, result) => sum + result.queued, 0), 1, JSON.stringify(results))
    const { rows: [child] } = await fixture.query('SELECT id,"ciContinuation" FROM agent_runs WHERE "ciContinuation" IS NOT NULL')
    assert.ok(child)
    assert.match(child.ciContinuation.followUp, /build/)
    assert.equal(child.ciContinuation.originSessionId, 'synthetic-original-session')
    // The resume holds the one budget row for this (task, PR, head).
    assert.deepEqual((await fixture.query('SELECT "runId",head FROM github_ci_resumes')).rows, [{ runId: child.id, head: sha }])
    const { preflightCiClaim, guardCiClaim, retryUnsentCiClaim } = await import('../lib/ci-continuation')
    // Claim reads only the database: no GitHub call happens from here on unless
    // reconcile runs.
    let providerCalls = 0
    const providerFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => { providerCalls++; return providerFetch(input, init) }
    const preflight = await preflightCiClaim(owner, child.ciContinuation)
    assert.equal(preflight.kind, 'valid')
    if (preflight.kind !== 'valid') throw Error('preflight did not succeed')
    const client = await fixture.connect()
    try {
      await client.query('BEGIN')
      const assignment = await guardCiClaim(client, owner, deviceId, child.id, child.ciContinuation, preflight.generation)
      assert.equal(assignment?.continuesRunId, runId)
      assert.equal(assignment?.resumeSessionId, 'synthetic-original-session')
      assert.equal(assignment?.requireSessionResume, true)
      await client.query('COMMIT')
    } finally { client.release() }
    assert.equal(providerCalls, 0)
    globalThis.fetch = providerFetch
    // A duplicate delivery arriving after provisional claim must prevent old
    // assignment bytes from escaping, but the unchanged result is retryable.
    const lease = new Date(Date.now() + 120_000).toISOString()
    await fixture.query(`UPDATE agent_runs SET status='preparing',"leaseExpiresAt"=$2 WHERE id=$1`, [child.id, lease])
    await fixture.query(`INSERT INTO run_tokens (id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(), child.id, owner, `token-${randomUUID()}`])
    assert.equal((await POST(signed())).status, 202)
    const { authorizedClaimResponse } = await import('../lib/run-claim-response')
    const hint = { id: child.id, issueId, agentId, deviceId, deviceRepoId: (await fixture.query('SELECT "deviceRepoId" FROM agent_runs WHERE id=$1', [child.id])).rows[0].deviceRepoId }
    assert.equal(await authorizedClaimResponse(owner, hint, lease, () => new Response('assignment'), preflight.generation), null)
    assert.equal(await retryUnsentCiClaim(owner, child.id, child.ciContinuation, lease), true)
    const recovered = (await fixture.query('SELECT status FROM agent_runs WHERE id=$1', [child.id])).rows[0]
    assert.equal(recovered.status, 'queued')
    assert.equal((await fixture.query('SELECT count(*)::int AS n FROM run_tokens WHERE "runId"=$1 AND "revokedAt" IS NULL', [child.id])).rows[0].n, 0)
    assert.equal((await preflightCiClaim(owner, child.ciContinuation)).kind, 'valid')
    // A new attempt on the same SHA changes the stable result: reconcile retires
    // the unclaimed follow-up, releases its budget, and queues the newer result.
    assert.equal((await POST(signed(2))).status, 202)
    assert.equal((await POST(signed(1))).status, 202) // late duplicate cannot rewind attempt 2
    assert.equal((await fixture.query('SELECT attempt FROM github_ci_workflow_attempts')).rows[0].attempt, 2)
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).pending, 1)
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1', [child.id])).rows[0].status, 'stopped')
    assert.equal((await fixture.query('SELECT count(*)::int n FROM github_ci_resumes')).rows[0].n, 0)
    assert.equal((await preflightCiClaim(owner, child.ciContinuation)).kind, 'stale')
    await fixture.query(`UPDATE github_ci_observations SET "firstSeenAt"=now()-interval '5 minutes',"nextCheckAt"=now()`)
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).queued, 1)
    const { rows: [rerunChild] } = await fixture.query(`SELECT id,"ciContinuation" FROM agent_runs WHERE "ciContinuation" IS NOT NULL AND status='queued'`)
    assert.notEqual(rerunChild.id, child.id)
    assert.notEqual(rerunChild.ciContinuation.fingerprint, child.ciContinuation.fingerprint)
    assert.equal((await preflightCiClaim(owner, rerunChild.ciContinuation)).kind, 'valid')
    // Once a follow-up for this head has been claimed, a later result for the
    // same head never resumes the session again (one resume per head).
    await fixture.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1`, [rerunChild.id])
    assert.equal((await POST(signed(3))).status, 202)
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).pending, 1)
    await fixture.query(`UPDATE github_ci_observations SET "firstSeenAt"=now()-interval '5 minutes',"nextCheckAt"=now()`)
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).deduped, 1)
    assert.equal((await fixture.query(`SELECT count(*)::int n FROM agent_runs WHERE "ciContinuation" IS NOT NULL AND status='queued'`)).rows[0].n, 0)
    // A new head with passing checks resumes once, after the same quiet window.
    providerHead = 'b'.repeat(40)
    providerConclusion = 'success'
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).pending, 1)
    await fixture.query(`UPDATE github_ci_observations SET "firstSeenAt"=now()-interval '5 minutes',"nextCheckAt"=now()`)
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).queued, 1)
    const { rows: [successChild] } = await fixture.query(`SELECT id,"ciContinuation" FROM agent_runs WHERE "ciContinuation" IS NOT NULL AND status='queued'`)
    assert.ok(successChild)
    assert.match(successChild.ciContinuation.followUp, /"result":"success"/)
    // A newer head seen by reconcile retires the unclaimed follow-up; claim then
    // finds it stale from the database alone.
    providerHead = 'c'.repeat(40)
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).pending, 1)
    assert.equal((await fixture.query('SELECT status FROM agent_runs WHERE id=$1', [successChild.id])).rows[0].status, 'stopped')
    assert.equal((await preflightCiClaim(owner, successChild.ciContinuation)).kind, 'stale')
    assert.deepEqual((await fixture.query('SELECT head FROM github_ci_resumes')).rows, [{ head: sha }])
    // A closed PR closes the watch, and reopening reactivates it without
    // inventing a new binding.
    providerOpen = false
    await fixture.query('UPDATE github_ci_observations SET "nextCheckAt"=now()')
    assert.equal((await reconcileCi({ pool, deadline: Date.now() + 30_000, limit: 1 })).closed, 1)
    providerOpen = true
    const reopenedBody = JSON.stringify({ action: 'reopened', number: 7, repository: { id: 77 }, installation: { id: 55 } })
    const reopened = new Request('http://localhost/api/webhooks/github', { method: 'POST', body: reopenedBody, headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(reopenedBody).digest('hex')}` } })
    assert.equal((await POST(reopened)).status, 202)
    assert.equal((await fixture.query('SELECT "expiresAt">now() AS active FROM github_ci_observations')).rows[0].active, true)
    // Failure isolation on real PG: a broken CI table never fails the webhook
    // (202 for the other handlers) and the CI transaction leaves no partial write.
    const before = (await fixture.query('SELECT generation FROM github_ci_observations')).rows[0].generation
    await fixture.query('ALTER TABLE github_ci_workflow_attempts RENAME TO github_ci_workflow_attempts_broken')
    const errors = test.mock.method(console, 'error', () => {})
    try {
      assert.equal((await POST(signed(3))).status, 202)
      assert.ok(errors.mock.calls.some(call => call.arguments[0] === 'GitHub CI result could not be recorded'))
    } finally {
      errors.mock.restore()
      await fixture.query('ALTER TABLE github_ci_workflow_attempts_broken RENAME TO github_ci_workflow_attempts')
    }
    assert.equal((await fixture.query('SELECT generation FROM github_ci_observations')).rows[0].generation, before)
  } finally {
    globalThis.fetch = originalFetch
    await scopedPool?.end().catch(() => {})
    await workspacePool?.end().catch(() => {})
    await fixture.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
