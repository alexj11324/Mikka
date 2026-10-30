import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { registerCiPublication } from './register'
import { retryPendingCiEscalations } from './escalation-recovery'
import { reconcileCi } from './reconcile'
import { summarize } from './snapshot'

const target = process.env.CI_TEST_PG_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
if (target) {
  const url = new URL(target)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/mikka_e2e' || url.search || url.hash) throw Error('CI test requires isolated loopback mikka_e2e')
}
if (process.env.REQUIRE_DB === '1' && !target) throw Error('CI observation DB test cannot skip')
const snapshot = { checks: [{ id: '1', name: 'build', status: 'completed', conclusion: 'failure' }], statuses: [] }
const summary = summarize(snapshot)
if (summary.kind !== 'complete') throw Error('fixture')

test('PG17: concurrent workers lock one observation; failure and capped escalation are durable', { skip: !target }, async () => {
  const schema = `ci_obs_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}` })
  const issue = randomUUID(), run = randomUUID(), agent = randomUUID()
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    await pool.query(`CREATE TABLE "user" (id text primary key);
      CREATE TABLE issues (id uuid primary key, content jsonb, "scopeVersion" int);
      CREATE TABLE agent_runs (id uuid primary key, "userId" text, "agentId" uuid, "botId" uuid, "createdAt" timestamptz default now());
      CREATE TABLE github_repository_installations ("userId" text, "remoteKey" text, "installationId" bigint, "repositoryId" bigint);
      CREATE TABLE run_publications ("runId" uuid, "userId" text, "issueId" uuid, "remoteKey" text, branch text, "pullRequest" jsonb, status text);
      CREATE TABLE coordinator_events (id uuid primary key, "userId" text, "botId" uuid, kind text, "dedupeKey" text unique, "issueId" uuid, "runId" uuid, payload jsonb, tier text, "deliveredAt" timestamptz, "lastTriageAttemptAt" timestamptz, "createdAt" timestamptz default now());
      CREATE TABLE deliveries ("issueId" uuid, fingerprint text, UNIQUE("issueId",fingerprint));`)
    await pool.query(await readFile('drizzle/20261030080000_ci_observations.sql', 'utf8'))
    await pool.query('INSERT INTO "user" VALUES ($1)', ['owner'])
    await pool.query('INSERT INTO issues VALUES ($1,$2,1)', [issue, JSON.stringify({})])
    await pool.query('INSERT INTO agent_runs(id,"userId","agentId") VALUES ($1,$2,$3)', [run, 'owner', agent])
    await pool.query('INSERT INTO github_repository_installations VALUES ($1,$2,4,5)', ['owner', 'v2/github.com/acme/repo'])
    await pool.query('INSERT INTO run_publications VALUES ($1,$2,$3,$4,$5,$6,$7)', [run, 'owner', issue, 'v2/github.com/acme/repo', 'mikka/test-1', JSON.stringify({url:'https://github.com/acme/repo/pull/3',state:'open'}), 'published'])
    await pool.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"firstSeenAt","expiresAt") VALUES ($1,$2,$3,3,$4,1,$5,$6,now()-interval '3 minutes',now()+interval '1 hour')`, ['owner', issue, 'v2/github.com/acme/repo', run, 'a'.repeat(40), summary.fingerprint])
    // GitHub can be slow: a stop and new webhook must take the issue/row
    // locks while the provider read is in flight. Its generation invalidates
    // the stale provider snapshot before any enqueue.
    let staleDelivered = 0
    const stale = await reconcileCi({ pool, deadline: Date.now()+30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0,
      read: async () => {
        const other = await pool.connect()
        try { await other.query('BEGIN'); await other.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE NOWAIT',[issue]); await other.query('UPDATE github_ci_observations SET generation=generation+1'); await other.query('COMMIT') } finally { other.release() }
        return { head: 'a'.repeat(40), open:true, snapshot }
      }, deliver: async () => { staleDelivered++ } })
    assert.equal(stale.queued,0); assert.equal(staleDelivered,0)
    let reads = 0, delivered = 0
    const read = async () => { reads++; await new Promise(resolve => setTimeout(resolve, 50)); return { head: 'a'.repeat(40), open: true, snapshot } }
    const deliver = async (tx: import('pg').PoolClient, _user: string, input: { issueId: string; fingerprint: string }) => { delivered++; await tx.query('INSERT INTO deliveries VALUES ($1,$2)', [input.issueId,input.fingerprint]) }
    const options = { pool, deadline: Date.now()+30_000, lockPolicy: (async () => ({})) as never, listAttempts: async () => [], retire: async () => 0, read, deliver }
    const outcomes = await Promise.all([reconcileCi(options),reconcileCi(options),reconcileCi(options)])
    assert.equal(outcomes.reduce((n,o)=>n+o.queued,0),1)
    assert.equal(delivered,1); assert.equal(reads,3)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM deliveries')).rows[0].n,1)
    const first = (await pool.query('SELECT "deliveredFingerprint" FROM github_ci_observations')).rows[0]
    assert.equal(first.deliveredFingerprint,summary.fingerprint)
    // A failed enqueue rolls back; it is backed off without losing the observation.
    await pool.query(`UPDATE github_ci_observations SET "nextCheckAt"=now(), "deliveredFingerprint"=NULL`)
    const fail = await reconcileCi({ ...options, deliver: async () => { throw Error('synthetic delivery failure') } })
    assert.equal(fail.failed,1)
    const retry = (await pool.query('SELECT "lastError", "deliveredFingerprint", "nextCheckAt">now() AS deferred FROM github_ci_observations')).rows[0]
    assert.deepEqual(retry,{lastError:'delivery_unavailable',deliveredFingerprint:null,deferred:true})
    // Capped follow-up stores failure for the person, without dispatching again.
    await pool.query(`UPDATE github_ci_observations SET "nextCheckAt"=now(), "chainDepth"=2, "lastError"=NULL`)
    let wakes = 0
    const capped = await reconcileCi({ ...options, wake: async () => { wakes++; throw Error('synthetic wake failure') } })
    assert.equal(capped.escalated,1); assert.equal(wakes,1); assert.equal(delivered,1)
    const event = (await pool.query('SELECT tier,payload FROM coordinator_events')).rows[0]
    assert.equal(event.tier,'attention'); assert.match(event.payload.text,/"result":"failure"/); assert.match(event.payload.text,/build/)
    await pool.query(`UPDATE github_ci_observations SET "nextCheckAt"=now()`)
    const retryWake = await reconcileCi({ ...options, wake: async () => { wakes++ } })
    assert.equal(retryWake.escalated,0); assert.equal(wakes,2)
    await pool.query(`UPDATE coordinator_events SET "deliveredAt"=now()`)
    await pool.query(`UPDATE github_ci_observations SET "nextCheckAt"=now()`)
    await reconcileCi({ ...options, wake: async () => { wakes++ } })
    assert.equal(wakes,2)
    // A pending event survives head changes and monitoring expiry.
    await pool.query(`UPDATE coordinator_events SET "deliveredAt"=NULL, "lastTriageAttemptAt"=NULL`)
    await pool.query(`UPDATE github_ci_observations SET head=$1,"expiresAt"=now()-interval '1 minute'`, ['b'.repeat(40)])
    const recovered = await retryPendingCiEscalations({pool,deadline:Date.now()+30000,wake:async () => { wakes++ }})
    assert.equal(recovered.attempted,1); assert.equal(wakes,3)
    const throttled = await retryPendingCiEscalations({pool,deadline:Date.now()+30000,wake:async () => { wakes++ }})
    assert.equal(throttled.attempted,0); assert.equal(wakes,3)
    await pool.query(`UPDATE coordinator_events SET "deliveredAt"=now()`)

    // Out-of-order receipt must not replace the newer bound execution. CI
    // continuations only advance their own current origin, once per run.
    const later = randomUUID(), oldRun = randomUUID(), alternate = randomUUID()
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","createdAt") VALUES ($1,'owner',$4,now()+interval '1 minute'),($2,'owner',$4,now()-interval '1 day'),($3,'owner',$4,now()+interval '2 minutes')`, [later, oldRun, alternate, agent])
    const db = drizzle(pool)
    const receipt = { userId: 'owner', issueId: issue, remoteKey: 'v2/github.com/acme/repo', scopeVersion: 1, url: 'https://github.com/acme/repo/pull/3', state: 'open' }
    await registerCiPublication(db, {...receipt, runId: later, ciOriginRunId: run})
    await registerCiPublication(db, {...receipt, runId: later, ciOriginRunId: run})
    await registerCiPublication(db, {...receipt, runId: oldRun})
    await registerCiPublication(db, {...receipt, runId: alternate, ciOriginRunId: run})
    const bound = (await pool.query('SELECT "originRunId","chainDepth" FROM github_ci_observations')).rows[0]
    assert.deepEqual(bound,{originRunId:later,chainDepth:3})
    // A missing workflow completed webhook is reconciled from the specific run;
    // its changed attempt participates in a fresh snapshot before delivery.
    await pool.query(`UPDATE github_ci_observations SET "originRunId"=$1,"chainDepth"=0,head=$2,fingerprint=$3,"firstSeenAt"=now()-interval '3 minutes',"deliveredFingerprint"=$3,"nextCheckAt"=now(),"expiresAt"=now()+interval '1 hour'`, [run,'a'.repeat(40),summary.fingerprint])
    await pool.query(`INSERT INTO github_ci_workflow_attempts ("userId","issueId","remoteKey","prNumber","runId",head,attempt,state) VALUES ('owner',$1,'v2/github.com/acme/repo',3,'456',$2,2,'in_progress')`, [issue,'a'.repeat(40)])
    const recoveryOptions = { pool,deadline:Date.now()+30000,lockPolicy:(async () => ({})) as never,retire:async () => 0,read,deliver,
      recoverAttempts:async () => [{runId:'456',attempt:2,state:'completed' as const}] }
    const reconcilePending = await reconcileCi(recoveryOptions)
    assert.equal(reconcilePending.queued,0)
    assert.equal((await pool.query('SELECT state FROM github_ci_workflow_attempts')).rows[0].state,'completed')
    assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n,1)
    await reconcileCi(recoveryOptions)
    await pool.query(`UPDATE github_ci_observations SET "nextCheckAt"=now(),"firstSeenAt"=now()-interval '3 minutes'`)
    const afterRecovery = await reconcileCi(recoveryOptions)
    assert.equal(afterRecovery.queued,1)
    assert.equal((await pool.query('SELECT count(*)::int n FROM deliveries')).rows[0].n,2)


  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
