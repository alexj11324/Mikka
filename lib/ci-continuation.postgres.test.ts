import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { isolatedPostgresURL } from '../tests/helpers/isolated-postgres.mjs'

const url = process.env.CI_CONTINUATION_TEST_DATABASE_URL ?? (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' ? process.env.E2E_DATABASE_URL : undefined)
test('CI continuation PG identity, generation and retirement', { skip: !url, timeout: 120_000 }, async t => {
const fixtureUrl = await isolatedPostgresURL(url!)
const schema = `ci_cont_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString: fixtureUrl })
await admin.query(`CREATE SCHEMA "${schema}"`)
const pool = new pg.Pool({ connectionString: fixtureUrl, options: `-c search_path=${schema}` })
mock.module('@/lib/db', { namedExports: { pool } })
mock.module('@/lib/agent-runs', { namedExports: { queueFactoryRun: async () => { throw Error('not used') } } })
mock.module('@/lib/github/repository-installation', { namedExports: { linkedGitHubAccountId: async () => null } })
mock.module('@/lib/github/run-pull-request', { namedExports: { verifyGitHubRepositoryAccess: async () => { throw Error('not used') } } })
mock.module('@/lib/github/ci/read', { namedExports: { readCi: async () => { throw Error('not used') } } })
mock.module('@/lib/github/ci/snapshot', { namedExports: { summarize: () => { throw Error('not used') } } })
const { guardCiClaim, retireStaleCiRun, retryUnsentCiClaim, retireSupersededCiRuns } = await import('./ci-continuation')
const c = { originRunId: 'origin', originSessionId: 'session', issueId: 'issue', remoteKey: 'v2/github.com/owner/repo', prNumber: 12, scopeVersion: 1, head: 'a'.repeat(40), fingerprint: 'b'.repeat(64), followUp: 'CI finished.', requireSessionResume: true as const }
try {
  await pool.query(`CREATE TABLE issues (id text PRIMARY KEY,"scopeVersion" integer NOT NULL);
    CREATE TABLE agent_runs (id text PRIMARY KEY,"userId" text,"issueId" text,"ciContinuation" jsonb,"agentId" text,"deviceRepoId" text,"botId" text,"deviceId" text,status text,"stopRequestedAt" timestamptz,"agentDefinition" jsonb,"sessionId" text,"stopReason" text,error text,"finishedAt" timestamptz,"updatedAt" timestamptz,"leaseExpiresAt" timestamptz);
    CREATE TABLE run_tokens ("runId" text,"userId" text,"revokedAt" timestamptz);
    CREATE TABLE github_ci_observations ("userId" text,"issueId" text,"remoteKey" text,"prNumber" integer,"originRunId" text,"scopeVersion" integer,head text,fingerprint text,"expiresAt" timestamptz,generation bigint,"deliveredFingerprint" text,"nextCheckAt" timestamptz,"updatedAt" timestamptz, PRIMARY KEY ("userId","issueId","remoteKey","prNumber"));`)
  await pool.query(`INSERT INTO issues VALUES ('issue',1);
    INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceRepoId","deviceId",status,"agentDefinition","sessionId") VALUES ('origin','owner','issue','agent','repo','device','succeeded','{"definitionDigest":"same"}','session');
    INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceRepoId","deviceId",status,"agentDefinition") VALUES ('child','owner','issue','agent','repo','device','queued','{"definitionDigest":"same"}');`)
  await pool.query('UPDATE agent_runs SET "ciContinuation"=$1 WHERE id=$2', [JSON.stringify(c), 'child'])
  await pool.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion",head,fingerprint,"expiresAt",generation,"deliveredFingerprint") VALUES ('owner','issue',$1,12,'origin',1,$2,$3,now()+interval '1 hour',4,$3)`, [c.remoteKey, c.head, c.fingerprint])
  await t.test('an unsent claim is requeued with provisional token revoked', async () => {
    const lease = new Date(Date.now() + 120_000).toISOString()
    await pool.query(`UPDATE agent_runs SET status='preparing',"leaseExpiresAt"=$1 WHERE id='child'`, [lease])
    await pool.query(`INSERT INTO run_tokens VALUES ('child','owner',NULL)`)
    assert.equal(await retryUnsentCiClaim('owner', 'child', c, lease), true)
    const current = await pool.query(`SELECT status,"leaseExpiresAt" FROM agent_runs WHERE id='child'`)
    assert.equal(current.rows[0].status, 'queued')
    assert.equal(current.rows[0].leaseExpiresAt.toISOString(), lease)
    assert.ok((await pool.query(`SELECT "revokedAt" FROM run_tokens`)).rows[0].revokedAt)
    assert.equal(await retryUnsentCiClaim('owner', 'child', c, lease), false)
  })
  await t.test('superseded result releases an offline queue without touching another tenant', async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const current = { issueId: 'issue', remoteKey: c.remoteKey, prNumber: 12, head: c.head, fingerprint: c.fingerprint }
      assert.equal(await retireSupersededCiRuns(tx, 'owner', current), 0)
      assert.equal(await retireSupersededCiRuns(tx, 'other', { ...current, fingerprint: null }), 0)
      assert.equal(await retireSupersededCiRuns(tx, 'owner', { ...current, fingerprint: null }), 0)
      assert.equal(await retireSupersededCiRuns(tx, 'owner', { ...current, head: 'new-head', fingerprint: null }), 1)
      assert.equal((await tx.query("SELECT status FROM agent_runs WHERE id='child'")).rows[0].status, 'stopped')
      await tx.query('ROLLBACK')
    } finally { tx.release() }
  })
  await t.test('real PG locks generation and original identity before session claim', async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const accepted = await guardCiClaim(tx, 'owner', 'device', 'child', c, '4')
      assert.equal(accepted?.resumeSessionId, 'session')
      assert.equal(accepted?.requireSessionResume, true)
      const concurrent = await pool.connect()
      try {
        await concurrent.query('BEGIN')
        await concurrent.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(concurrent.query('UPDATE github_ci_observations SET generation=generation+1'), { code: '55P03' })
        await concurrent.query('ROLLBACK')
      } finally { concurrent.release() }
      await tx.query('ROLLBACK')
      await pool.query('UPDATE github_ci_observations SET generation=5')
      await tx.query('BEGIN')
      assert.equal(await guardCiClaim(tx, 'owner', 'device', 'child', c, '4'), null)
      await tx.query('ROLLBACK')
      assert.equal(await retireStaleCiRun('owner', 'child', c, '4'), false)
      assert.equal((await pool.query("SELECT status FROM agent_runs WHERE id='child'")).rows[0].status, 'queued')
      assert.equal(await retireStaleCiRun('owner', 'child', c, '5'), true)
      assert.equal((await pool.query("SELECT status FROM agent_runs WHERE id='child'")).rows[0].status, 'stopped')
      const observed = (await pool.query('SELECT generation,"deliveredFingerprint" FROM github_ci_observations')).rows[0]
      assert.equal(observed.generation, '6')
      assert.equal(observed.deliveredFingerprint, null)
    } finally { tx.release() }
  })
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
}

})
