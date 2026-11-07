import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// This issue-specific runner emits counts only. The workflow keeps incidental
// business diagnostics private and publishes only this deliberately small report.
const report: Record<string, unknown> = { issues: [1515, 1517], startedAt: new Date().toISOString(), status: 'started' }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
let close: (() => Promise<unknown>) | undefined

try {
  check(process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && process.env.GITHUB_REF === 'refs/heads/ops/1515-1517-acceptance', 'cleanup_scope_mismatch')
  const application = process.env.APPLICATION_SHA
  check(application && /^[a-f0-9]{40}$/.test(application), 'cleanup_application_required')
  execFileSync('git', ['merge-base', '--is-ancestor', application, 'HEAD'], { stdio: 'ignore' })
  execFileSync('git', ['diff', '--quiet', application, '--', 'lib/demo-device-cleanup.ts', 'lib/subscription-acquire-expiry.ts', 'lib/device-presence.ts', 'packages/protocol/src/device.ts'], { stdio: 'ignore' })
  const mode = process.env.CLEANUP_MODE ?? 'dry-run'
  check(mode === 'dry-run' || mode === 'apply', 'cleanup_mode_invalid')
  report.mode = mode
  const response = await fetch('https://app.aspectlylabs.com/mikka/api/version', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) })
  const version = await response.json() as { build?: unknown }
  check(response.ok && version.build === application, 'cleanup_production_revision_mismatch')
  report.application = application
  check(process.env.MIKKA_DATABASE_URL && process.env.DATABASE_URL, 'cleanup_database_required')
  check(!process.env.VERCEL && !process.env.WORKFLOW_TARGET_WORLD && process.env.NODE_ENV !== 'development', 'cleanup_runtime_mismatch')
  const [{ pool }, { workspacePool }, { removeDemoDevices }, { expireSubscriptionAcquisitions }, { deviceOnlineStates }] = await Promise.all([
    import('../../lib/db/index.ts'), import('../../lib/workspace-db.ts'),
    import('../../lib/demo-device-cleanup.ts'), import('../../lib/subscription-acquire-expiry.ts'),
    import('../../lib/device-presence.ts'),
  ])
  close = () => Promise.all([pool.end(), workspacePool.end()])
  const demo = `id::text LIKE 'de30000%' AND "daemonVersion"='0.9.4' AND kind='local'`
  const active = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
  const snapshot = async () => {
    const real = (await pool.query(`SELECT id,"ownerId",kind,name,enabled,"removedAt" FROM devices WHERE (${demo}) IS NOT TRUE ORDER BY id`)).rows
    const bindings = (await pool.query(`SELECT a.id,a."deviceId" FROM agents a WHERE a."deviceId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=a."deviceId" AND d.id::text LIKE 'de30000%' AND d."daemonVersion"='0.9.4' AND d.kind='local') ORDER BY a.id`)).rows
    return { real, bindings }
  }
  const before = await snapshot()
  const historical = (await pool.query(`SELECT r.id,md5(to_jsonb(r)::text) AS digest FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE d.id::text LIKE 'de30000%' AND d."daemonVersion"='0.9.4' AND d.kind='local' AND NOT (r.status=ANY($1::text[])) ORDER BY r.id`, [active])).rows
  const plan = await removeDemoDevices(false)
  report.devicePlan = plan
  // The shared test account does not own Alex's old demo devices. Verify these
  // exact production rows through the unchanged deployed presence function,
  // separately from the normal account API proof, before removing them.
  const future = (await pool.query(`SELECT id,"lastSeenAt" FROM devices WHERE ${demo} AND "removedAt" IS NULL AND "lastSeenAt">now() ORDER BY id LIMIT 100`)).rows
  check(future.length < 100, 'cleanup_future_sample_limit')
  const futureStates = await deviceOnlineStates(future, Date.now())
  report.futureDemoPresence = { samples: future.length, online: [...futureStates.values()].filter(Boolean).length, verification: 'deployed_business_module_readonly' }
  check([...futureStates.values()].every(online => !online), 'cleanup_future_device_online')
  report.realDevicesBefore = before.real.filter(row => !row.removedAt).length
  report.historicalRunsBefore = historical.length

  // Use the production expiry function in a transaction. Its unrelated rows
  // must compare equal before COMMIT; a mismatch rolls this sweep back.
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await client.query("SET LOCAL statement_timeout='30s'")
    const targetRows = (await client.query(`SELECT c.id FROM byos_connections c WHERE c."removedAt" IS NULL
      AND c.state IN ('pending','reconnect_required','disconnected') AND c."updatedAt"<now()-interval '1 hour'
      AND (c."operationDeadline" IS NULL OR c."operationDeadline"<now())
      AND c."providerSubject" IS NULL AND c."accountLabel" IS NULL
      AND c."secretName" IS NULL AND c."secretDigest" IS NULL AND c."accessSecretName" IS NULL AND c."accessDigest" IS NULL
      AND c."stagedSecretName" IS NULL AND c."stagedDigest" IS NULL AND c."stagedAccessName" IS NULL AND c."stagedAccessDigest" IS NULL
      AND NOT EXISTS(SELECT 1 FROM byos_bindings b WHERE b."connectionId"=c.id)
      AND NOT EXISTS(SELECT 1 FROM byos_oauth_attempts a WHERE a."connectionId"=c.id AND a."consumedAt" IS NULL AND a."expiresAt">now())
      AND NOT EXISTS(SELECT 1 FROM byos_enrollment_transfers t WHERE t."connectionId"=c.id AND t.epoch=c.epoch AND t."operationId"=c."operationId")
      ORDER BY c.id`)).rows
    const ids = targetRows.map(row => row.id as string)
    const protectedRows = async () => (await client.query(`SELECT c.id,md5(to_jsonb(c)::text) AS digest FROM byos_connections c WHERE NOT (c.id::text=ANY($1::text[])) ORDER BY c.id`, [ids])).rows
    const protectedBefore = await protectedRows()
    report.emptyConnectionsBefore = ids.length
    // Exercise the exact normal expiry in dry-run too, then ROLLBACK. This
    // exposes extra candidates or skipped locks before any durable cleanup.
    const result = await expireSubscriptionAcquisitions(client)
    check(result.expired === ids.length, 'cleanup_subscription_count_mismatch')
    check(same(protectedBefore, await protectedRows()), 'cleanup_protected_subscription_changed')
    const remaining = (await client.query(`SELECT count(*)::int AS n FROM byos_connections WHERE id::text=ANY($1::text[]) AND (state<>'disconnected' OR "removedAt" IS NULL)`, [ids])).rows[0].n
    check(remaining === 0, 'cleanup_subscription_not_removed')
    report.emptyConnectionsValidated = result.expired
    report.otherConnectionsPreserved = protectedBefore.length
    if (mode === 'apply') {
      report.emptyConnectionsRemoved = result.expired
      report.connectionOwners = result.ownerIds.length
      await client.query('COMMIT')
      report.subscriptionTransactionCommitted = true
    } else {
      await client.query('ROLLBACK')
      report.subscriptionTransactionRolledBack = true
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }

  if (mode === 'apply') {
    const applied = await removeDemoDevices(true)
    report.devicesApplied = applied
    check(applied.removedDevices === plan.devices && applied.stoppedRuns === plan.activeRuns, 'cleanup_device_count_mismatch')
    const after = await snapshot()
    check(same(before, after), 'cleanup_real_device_changed')
    const historyAfter = (await pool.query(`SELECT r.id,md5(to_jsonb(r)::text) AS digest FROM agent_runs r WHERE r.id::text=ANY($1::text[]) ORDER BY r.id`, [historical.map(row => row.id)])).rows
    check(same(historical, historyAfter), 'cleanup_historical_run_changed')
    const remaining = await removeDemoDevices(false)
    check(remaining.devices === 0 && remaining.activeRuns === 0, 'cleanup_demo_remaining')
    report.devicesAfter = remaining
    report.realDevicesAfter = after.real.filter(row => !row.removedAt).length
    report.realDeviceBindingsPreserved = after.bindings.length
    report.historicalRunsPreserved = historyAfter.length
  }
  report.status = 'complete'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error && /^cleanup_[a-z_]+$/.test(error.message) ? error.message : 'cleanup_step_failed'
  process.exitCode = 1
} finally {
  try { await close?.() } catch {
    report.status = 'failed'
    report.cleanupError = 'cleanup_pool_close_failed'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  mkdirSync('issues-1515-1517-cleanup-report', { recursive: true })
  writeFileSync(`issues-1515-1517-cleanup-report/${report.mode === 'apply' ? 'apply' : 'dry-run'}.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
