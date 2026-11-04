import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const connectionString = process.env.MIKKA_EGRESS_TEST_DATABASE_URL
assert.ok(connectionString, 'isolated local database required')
const target = new URL(connectionString)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && /^\/[a-z0-9_]*e2e[a-z0-9_]*$/.test(target.pathname), 'refusing non-isolated database')
const repo = resolve(process.env.MIKKA_REPO_PATH ?? process.cwd())
const { Pool } = createRequire(join(repo, 'package.json'))('pg')
const pool = new Pool({ connectionString, max: 1 })
const client = await pool.connect()
const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000
const runId = '10000000-0000-4000-8000-000000000001'
const issueId = '20000000-0000-4000-8000-000000000001'
const otherId = '10000000-0000-4000-8000-000000000002'
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const generated = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'mikka-egress-hour.mjs'), 'neon-sql'], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, MIKKA_REPO_PATH: repo,
    EGRESS_SOURCE_SHA: sourceSha, EGRESS_PATH: 'codex_subscription', EGRESS_WINDOW_START: new Date(start).toISOString(),
    EGRESS_RUN_ID: runId, EGRESS_ISSUE_ID: issueId },
})
assert.equal(generated.status, 0, generated.stderr)
const { sql } = JSON.parse(generated.stdout)
const at = offset => new Date(start + offset).toISOString()
const sample = async () => (await client.query(sql)).rows[0]

try {
  await client.query('BEGIN')
  // Temporary tables shadow public fixtures in this connection only and are
  // rolled back. No existing run, schema or application authority is changed.
  await client.query(`CREATE TEMP TABLE agent_runs(id uuid PRIMARY KEY, "userId" text, "issueId" uuid, status text,
    "startedAt" timestamptz, "finishedAt" timestamptz, "updatedAt" timestamptz, "leaseExpiresAt" timestamptz,
    source text, "agentDefinition" jsonb, "lastReplyAt" timestamptz) ON COMMIT DROP`)
  await client.query('CREATE TEMP TABLE run_chunks("runId" uuid,seq integer,"createdAt" timestamptz) ON COMMIT DROP')
  await client.query(`INSERT INTO agent_runs(id,"userId","issueId",status,"startedAt","updatedAt","leaseExpiresAt","agentDefinition")
    VALUES($1,'fixture-owner',$2,'running',$3,$3,$4,$5)`, [runId, issueId, at(-60_000), at(7_200_000), {
      model: 'gpt-6-luna', harness: 'codex', modelSource: 'subscription', cliModelSelection: 'explicit', readOnly: true,
      subscription: { modelId: 'gpt-6-luna', route: 'codex_cli' },
    }])
  await client.query('INSERT INTO run_chunks VALUES($1,1,$2)', [runId, at(0)])
  const historical = async () => {
    await client.query('DELETE FROM run_chunks WHERE "runId"=$1', [otherId])
    await client.query('DELETE FROM agent_runs WHERE id=$1', [otherId])
    await client.query(`INSERT INTO agent_runs(id,"userId","issueId",status,"startedAt","updatedAt")
      VALUES($1,'fixture-owner',$2,'running',$3,$3)`, [otherId, issueId, at(-172_800_000)])
    await client.query('INSERT INTO run_chunks VALUES($1,1,$2)', [otherId, at(-172_800_000)])
  }

  await test('the frozen read-only flag remains a JSON boolean, with missing authority visible as null', async () => {
    assert.equal((await sample()).readOnly, true)
    await client.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{readOnly}\',\'false\') WHERE id=$1', [runId])
    assert.equal((await sample()).readOnly, false)
    await client.query('UPDATE agent_runs SET "agentDefinition"="agentDefinition"-\'readOnly\' WHERE id=$1', [runId])
    assert.equal((await sample()).readOnly, null)
    await client.query('UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",\'{readOnly}\',\'true\') WHERE id=$1', [runId])
  })

  await test('inert unadmitted historical rows remain in raw counts but are not actual model concurrency', async () => {
    await historical()
    const row = await sample()
    assert.equal(row.rawOtherOwnerRunningRuns, '1')
    assert.equal(row.rawOtherRunningRuns, '1')
    assert.equal(row.rawOtherWindowRuns, '1')
    assert.equal(row.historicalRunningRows, '1')
    assert.equal(row.historicalWindowRows, '1')
    assert.equal(row.otherRunningRuns, '0')
    assert.equal(row.otherWindowRuns, '0')
  })
  await test('a new chunk, update, lease or frozen definition each makes the historical row count again', async () => {
    for (const mutation of [
      () => client.query('INSERT INTO run_chunks VALUES($1,2,$2)', [otherId, at(60_000)]),
      () => client.query('UPDATE agent_runs SET "updatedAt"=$2 WHERE id=$1', [otherId, at(60_000)]),
      () => client.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [otherId, at(60_000)]),
      () => client.query('UPDATE agent_runs SET "agentDefinition"=\'{}\'::jsonb WHERE id=$1', [otherId]),
    ]) {
      await historical(); await mutation()
      const row = await sample()
      assert.equal(row.historicalRunningRows, '0')
      assert.equal(row.otherRunningRuns, '1')
      assert.equal(row.otherWindowRuns, '1')
    }
  })
  await test('a short actual run between sample points is still an overlapping execution', async () => {
    await historical()
    await client.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=$2,"finishedAt"=$3,"updatedAt"=$3,"agentDefinition"='{}' WHERE id=$1`, [otherId, at(61_000), at(119_000)])
    const row = await sample()
    assert.equal(row.otherRunningRuns, '0')
    assert.equal(row.otherWindowRuns, '1')
    assert.equal(row.historicalWindowRows, '0')
  })
  await test('recent or incompletely timestamped unadmitted rows cannot be silently excluded', async () => {
    await historical()
    await client.query('UPDATE agent_runs SET "updatedAt"=NULL WHERE id=$1', [otherId])
    assert.equal((await sample()).otherRunningRuns, '1')
    await historical()
    await client.query('UPDATE agent_runs SET "startedAt"=$2 WHERE id=$1', [otherId, at(-60_000)])
    assert.equal((await sample()).otherRunningRuns, '1')
  })
} finally {
  await client.query('ROLLBACK').catch(() => {})
  client.release()
  await pool.end()
}
