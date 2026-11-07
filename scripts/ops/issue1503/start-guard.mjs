// Issue #1503 only: run once after both Actions locks, before either paid case.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const QUERY_SOURCE_SHA256 = "c339b97ddec600da338c30314b1b07783272a65459bb80a1c986222eabbadcc5"
const TARGET_SOURCE_SHA256 = "e8dcb5f81e45af71c6eff8902c3ec974fdf42699550af0312f71445026af6c21"
const SQL_STATEMENTS = [
  "SET TRANSACTION READ ONLY",
  "SET LOCAL statement_timeout = '30s'",
  "WITH fixture_bots AS (\n  SELECT id FROM bots WHERE \"workspaceId\" = '93f38d33-9447-4eaf-8a46-0d8889165bcd'\n), fixture_tasks AS (\n  SELECT id, \"issueId\", status FROM factory_tasks WHERE \"botId\" IN (SELECT id FROM fixture_bots)\n), fixture_runs AS (\n  SELECT r.id, r.status FROM agent_runs r\n  WHERE r.\"botId\" IN (SELECT id FROM fixture_bots)\n     OR EXISTS (SELECT 1 FROM thread_machines m WHERE m.\"runId\" = r.id AND m.\"workspaceId\" = '93f38d33-9447-4eaf-8a46-0d8889165bcd')\n     OR EXISTS (SELECT 1 FROM computer_run_bindings b WHERE b.\"runId\" = r.id AND b.\"workspaceId\" = '93f38d33-9447-4eaf-8a46-0d8889165bcd')\n     OR EXISTS (SELECT 1 FROM factory_attempts a WHERE a.\"runId\" = r.id AND a.\"taskId\" IN (SELECT id FROM fixture_tasks))\n)\nSELECT\n  (SELECT count(*) FROM fixture_runs WHERE status = ANY(ARRAY['queued','preparing','running','paused','waiting_input','finishing']::text[])) AS \"activeRuns\",\n  (SELECT count(*) FROM fixture_tasks WHERE status IN ('pending','running','waiting')) AS \"pendingFactoryTasks\",\n  (SELECT count(*) FROM bot_subagents WHERE \"workspaceId\" = '93f38d33-9447-4eaf-8a46-0d8889165bcd' AND status IN ('queued','running','needs_you')) AS \"pendingSubagents\",\n  (SELECT count(*) FROM coordinator_sessions WHERE \"botId\" IN (SELECT id FROM fixture_bots) AND (\"leaseUntil\" > now() OR (\"leaseHolder\" IS NOT NULL AND \"leaseUntil\" IS NULL))) AS \"coordinatorLeases\",\n  (SELECT count(*) FROM run_publications WHERE (\"runId\" IN (SELECT id FROM fixture_runs) OR \"issueId\" IN (SELECT \"issueId\" FROM fixture_tasks)) AND (status IN ('pending','processing') OR \"leaseExpiresAt\" > now())) AS \"pendingPublications\",\n  (SELECT count(*) FROM factory_merges WHERE \"taskId\" IN (SELECT id FROM fixture_tasks) AND status = 'merging') AS \"pendingMerges\",\n  (SELECT count(*) FROM thread_machines WHERE \"ownerId\" = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3' AND (state = 'running' OR \"workerLeaseUntil\" > now() OR (\"workerLeaseId\" IS NOT NULL AND \"workerLeaseUntil\" IS NULL))) AS \"activeThreadMachines\",\n  (SELECT count(*) FROM cloud_machines WHERE \"ownerId\" = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3' AND (state IN ('running','waking') OR \"workerLeaseUntil\" > now() OR \"provisionLeaseUntil\" > now() OR (\"workerLeaseId\" IS NOT NULL AND \"workerLeaseUntil\" IS NULL) OR (\"provisionLeaseId\" IS NOT NULL AND \"provisionLeaseUntil\" IS NULL))) AS \"activeCloudMachines\""
]
const TARGET = {
  "database": "orvilo_mvp",
  "allowedHosts": [
    "ep-twilight-violet-b5lbqgbv.c-7.us-east-2.aws.neon.tech",
    "ep-twilight-violet-b5lbqgbv-pooler.c-7.us-east-2.aws.neon.tech",
    "ep-twilight-violet-b5lbqgbv-cyd.c-7.us-east-2.aws.neon.tech",
    "ep-twilight-violet-b5lbqgbv-cyd-pooler.c-7.us-east-2.aws.neon.tech"
  ]
}
const FIXTURE_PATH = 'scripts/ops/issue1503/fixture-state.json'
const REPORT_PATH = 'issue1503-report/start-guard.json'
const REQUIRED_MARGIN_MS = 100 * 60_000
const COUNT_KEYS = [
  'activeRuns', 'pendingFactoryTasks', 'pendingSubagents', 'coordinatorLeases',
  'pendingPublications', 'pendingMerges', 'activeThreadMachines', 'activeCloudMachines',
]
const hash = value => createHash('sha256').update(value).digest('hex')
class GuardFailure extends Error {}
function requireGuard(condition, code) {
  if (!condition) throw new GuardFailure(code)
}
function credentialMargin(state, now) {
  const connection = Date.parse(state.githubSetup?.connectionExpiresAt)
  const provider = Date.parse(state.githubSetup?.providerExpiresAt)
  requireGuard(Number.isFinite(connection) && Number.isFinite(provider), 'credential_expiry_invalid')
  return { connectionMs: connection - now, providerMs: provider - now, requiredMs: REQUIRED_MARGIN_MS }
}
function requireMargin(margin) {
  requireGuard(margin.connectionMs >= REQUIRED_MARGIN_MS && margin.providerMs >= REQUIRED_MARGIN_MS,
    'credential_margin_insufficient')
}
function exactCounts(result) {
  requireGuard(result.rowCount === 1 && result.rows.length === 1, 'idle_result_shape')
  const row = result.rows[0]
  requireGuard(Object.keys(row).sort().join(',') === [...COUNT_KEYS].sort().join(','), 'idle_result_keys')
  const counts = {}
  for (const key of COUNT_KEYS) {
    const raw = row[key]
    requireGuard(typeof raw === 'number' || (typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw)),
      'idle_result_value')
    const value = Number(raw)
    requireGuard(Number.isSafeInteger(value) && value >= 0, 'idle_result_value')
    counts[key] = value
  }
  return counts
}

async function main() {
  const report = {
    version: 1, issue: 1503, phase: 'factory_start_guard',
    startedAt: new Date().toISOString(), status: 'failed', code: 'guard_incomplete',
    operatorSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
    querySourceSha256: QUERY_SOURCE_SHA256, querySha256: hash(SQL_STATEMENTS[2]),
    targetSourceSha256: TARGET_SOURCE_SHA256,
    target: { applicationConfigurationOnly: false, approvedHostnameMatched: false, databaseMatched: false },
    fixtureSha256: null, fixtureScopeMatched: false,
    credentialSource: 'frozen_R5_fixture', credentialMargin: null,
    counts: null,
    transaction: { started: false, readOnly: false, statementTimeoutMs: null, idleSelectCalls: 0, rolledBack: false },
  }
  let state, pool, client, inTransaction = false
  try {
    requireGuard(process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV === 'production'
      && process.env.MIKKA_EDITION === 'cloud', 'production_configuration_required')
    const bytes = await readFile(FIXTURE_PATH)
    report.fixtureSha256 = hash(bytes)
    requireGuard(/^[a-f0-9]{64}$/.test(process.env.MIKKA_1503_START_FIXTURE_SHA256 ?? '')
      && report.fixtureSha256 === process.env.MIKKA_1503_START_FIXTURE_SHA256, 'fixture_sha_mismatch')
    state = JSON.parse(bytes.toString('utf8'))
    requireGuard(state.issue === 1503 && state.workspaceId === '93f38d33-9447-4eaf-8a46-0d8889165bcd'
      && state.smokeUserId === 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
      && state.githubSetup?.userId === state.smokeUserId
      && state.githubSetup?.repository === 'alexj11324/Mikka-handoff', 'fixture_scope_mismatch')
    report.fixtureScopeMatched = true
    report.credentialMargin = credentialMargin(state, Date.now())
    requireMargin(report.credentialMargin)

    // Actual app routing: never use workspacePool or fall back to DATABASE_URL.
    const { mikkaDatabaseURL } = await import('../../../lib/db/config.ts')
    const connectionString = mikkaDatabaseURL(process.env)
    requireGuard(typeof connectionString === 'string' && connectionString.length > 0
      && connectionString === process.env.MIKKA_DATABASE_URL, 'application_database_required')
    report.target.applicationConfigurationOnly = true
    let url
    try { url = new URL(connectionString) } catch (error) { throw new GuardFailure('database_target_invalid', { cause: error }) }
    requireGuard(url.protocol === 'postgres:' || url.protocol === 'postgresql:', 'database_target_invalid')
    requireGuard(TARGET.allowedHosts.includes(url.hostname), 'database_target_mismatch')
    report.target.approvedHostnameMatched = true
    let database
    try { database = decodeURIComponent(url.pathname.slice(1)) } catch (error) { throw new GuardFailure('database_target_invalid', { cause: error }) }
    requireGuard(database === TARGET.database, 'database_target_mismatch')
    report.target.databaseMatched = true

    // Import only after URL checks; existing production pool uses this same config function.
    ;({ pool } = await import('../../../lib/db/index.ts'))
    client = await pool.connect()
    await client.query({ text: 'BEGIN', query_timeout: 5_000 })
    inTransaction = true
    report.transaction.started = true
    await client.query({ text: SQL_STATEMENTS[0], query_timeout: 5_000 })
    report.transaction.readOnly = true
    await client.query({ text: SQL_STATEMENTS[1], query_timeout: 5_000 })
    report.transaction.statementTimeoutMs = 30_000
    report.transaction.idleSelectCalls = 1
    report.counts = exactCounts(await client.query({ text: SQL_STATEMENTS[2], query_timeout: 35_000 }))
    requireGuard(COUNT_KEYS.every(key => report.counts[key] === 0), 'fixture_not_idle')
    report.code = 'passed'
  } catch (error) {
    report.code = error instanceof GuardFailure ? error.message : 'guard_execution_failed'
  } finally {
    if (client) {
      if (inTransaction) {
        try {
          await client.query({ text: 'ROLLBACK', query_timeout: 5_000 })
          report.transaction.rolledBack = true
        } catch { report.code = 'readonly_transaction_close_failed' }
      }
      try { client.release(true) } catch { report.code = 'database_client_close_failed' }
    }
    if (pool) {
      try { await pool.end() } catch { report.code = 'database_pool_close_failed' }
    }
    if (state) {
      try {
        report.credentialMargin = credentialMargin(state, Date.now())
        requireMargin(report.credentialMargin)
      } catch (error) {
        if (report.code === 'passed') report.code = error instanceof GuardFailure ? error.message : 'credential_expiry_invalid'
      }
    }
    report.status = report.code === 'passed' && report.transaction.rolledBack ? 'passed' : 'failed'
    report.completedAt = new Date().toISOString()
    await mkdir('issue1503-report', { recursive: true })
    // One immutable final receipt; caught failures use the same always-uploaded directory.
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ phase: report.phase, status: report.status, code: report.code }))
    if (report.status !== 'passed') process.exitCode = 1
  }
}
main().catch(() => {
  console.log(JSON.stringify({ phase: 'factory_start_guard', status: 'failed', code: 'guard_receipt_write_failed' }))
  process.exitCode = 1
})
