import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Public model IDs from the pre-change inventory (job 128114103732). This is
// an acceptance baseline, not the default-selection algorithm.
const BASELINE_MODELS = [
  'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
  'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8',
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-6',
  'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
] as const
const CODES = new Set([
  'self_scope_mismatch', 'self_application_required', 'self_revision_invalid',
  'self_application_ancestry_failed', 'self_business_revision_mismatch',
  'self_production_revision_mismatch', 'self_database_required', 'self_runtime_mismatch',
  'self_workspace_not_unique', 'self_owner_membership_required', 'self_read_only_required',
  'self_customized_order', 'self_full_catalogue_mismatch', 'self_default_count_mismatch',
  'self_latest_defaults_mismatch', 'self_catalogue_mutated', 'self_cleanup_failed', 'self_step_failed',
])
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right)
const report: Record<string, unknown> = {
  version: 1, issue: 1515, passed: false, readOnly: true, modelRequests: 0,
  baselineModelCount: BASELINE_MODELS.length,
}
const shutdown: (() => Promise<unknown>)[] = []
let stepCode = 'self_step_failed'

try {
  check(process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && process.env.GITHUB_REF === 'refs/heads/ops/1515-1517-acceptance'
    && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'self_scope_mismatch')
  const application = process.env.APPLICATION_SHA
  check(sha(application), 'self_application_required')
  check(sha(process.env.GITHUB_SHA), 'self_revision_invalid')
  check(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === process.env.GITHUB_SHA, 'self_revision_invalid')
  report.applicationSha = application
  report.driverRevision = process.env.GITHUB_SHA
  stepCode = 'self_application_ancestry_failed'
  execFileSync('git', ['merge-base', '--is-ancestor', application, 'HEAD'], { stdio: 'ignore' })
  stepCode = 'self_business_revision_mismatch'
  execFileSync('git', ['diff', '--quiet', application, '--', 'lib/model-order.ts', 'lib/model-order-plan.ts'], { stdio: 'ignore' })
  report.deployedBusinessModulesMatched = true
  stepCode = 'self_step_failed'
  const pin = async () => {
    const response = await fetch('https://app.aspectlylabs.com/mikka/api/version', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'cache-control': 'no-cache' },
    })
    const value = await response.json() as { build?: unknown }
    check(response.ok && value.build === application, 'self_production_revision_mismatch')
    report.productionBuildMatched = true
  }
  await pin()
  check(process.env.MIKKA_DATABASE_URL && process.env.DATABASE_URL, 'self_database_required')
  check(!process.env.VERCEL && !process.env.WORKFLOW_TARGET_WORLD && process.env.NODE_ENV !== 'development'
    && process.env.VERCEL_ENV !== 'preview', 'self_runtime_mismatch')

  // These imports define services and lazy pools; no service, catalogue refresh,
  // quota probe, credential opening or model request is invoked. Nested main-DB
  // reads also inherit the held read-only client below. Pooled workspace access
  // uses the existing authorization SELECT FOR SHARE, which writes no rows.
  const { pool, withDatabaseClient } = await import('../../lib/db/index.ts')
  shutdown.push(() => pool.end())
  const { workspacePool } = await import('../../lib/workspace-db.ts')
  shutdown.push(() => workspacePool.end())
  const { orderCandidates, readOrder } = await import('../../lib/model-order.ts')
  const { entryKey, latestDefaultCandidates } = await import('../../lib/model-order-plan.ts')

  const workspaceClient = await workspacePool.connect()
  let scope: { ownerId: string; workspaceId: string }
  try {
    await workspaceClient.query('BEGIN READ ONLY')
    await workspaceClient.query("SET LOCAL statement_timeout='20s'")
    const readOnly = (await workspaceClient.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only
    check(readOnly === 'on', 'self_read_only_required')
    report.workspaceLookupReadOnly = true
    // The issue's public selector must identify exactly one workspace. Ownership
    // is the workspace's userId; membership roles are admin/member, not owner.
    const { rows } = await workspaceClient.query<{ id: string; userId: string; ownerActive: boolean }>(`
      SELECT w.id,w."userId",EXISTS(SELECT 1 FROM mikka_workspace_members m
        WHERE m."workspaceId"=w.id AND m."userId"=w."userId" AND m.status='active') AS "ownerActive"
      FROM mikka_workspaces w WHERE w.name=$1 AND w."userId" LIKE $2 ORDER BY w.id LIMIT 2`, ['自用', 'XjTsvV1A%'])
    report.workspaceMatchCount = rows.length
    check(rows.length === 1, 'self_workspace_not_unique')
    check(rows[0].ownerActive, 'self_owner_membership_required')
    report.activeOwnerVerified = true
    scope = { ownerId: rows[0].userId, workspaceId: rows[0].id }
  } finally {
    try { await workspaceClient.query('ROLLBACK') } finally { workspaceClient.release() }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    await client.query("SET LOCAL statement_timeout='20s'")
    const readOnly = (await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only
    check(readOnly === 'on', 'self_read_only_required')
    report.mainTransactionReadOnly = true
    await withDatabaseClient(client, async () => {
      const candidates = await orderCandidates(client, scope)
      const before = candidates.map(entryKey)
      const fullModels = [...new Set(candidates.map(candidate => candidate.model))].sort()
      const baseline = [...BASELINE_MODELS].sort()
      report.candidateCount = candidates.length
      report.candidateModelCount = fullModels.length
      report.missingBaselineModels = baseline.filter(model => !fullModels.includes(model))
      report.unexpectedModelCount = fullModels.filter(model => !baseline.includes(model as typeof BASELINE_MODELS[number])).length
      check(report.missingBaselineModels instanceof Array && report.missingBaselineModels.length === 0, 'self_full_catalogue_mismatch')
      const groups = new Map<string, typeof candidates>()
      for (const candidate of candidates) {
        const id = candidate.source.kind === 'subscription' ? candidate.source.connectionId : candidate.source.keyId
        const key = candidate.source.kind + ':' + id
        groups.set(key, [...(groups.get(key) ?? []), candidate])
      }
      report.sources = [...groups.values()].map(items => ({kind: items[0].source.kind, provider: items[0].provider, entries: items.length, models: [...new Set(items.map(item => item.model))].sort()}))
      report.candidateModels = fullModels
      report.fullCataloguePreserved = true

      const order = await readOrder(client, scope, candidates)
      report.customized = order.customized
      report.autoModelRouting = order.autoModelRouting
      report.defaultCount = order.entries.length
      check(order.customized === false, 'self_customized_order')
      check(order.entries.length > 0, 'self_default_count_mismatch')
      // Reuse the deployed selector, including its account/family boundaries;
      // never copy its version parsing or select defaults from a second list.
      const latest = latestDefaultCandidates(candidates)
      const latestKeys = new Set(latest.map(entryKey))
      const defaultKeys = new Set(order.entries.map(entryKey))
      report.latestCandidateCount = latest.length
      report.legacyCandidateCount = candidates.length - latest.length
      report.legacyDefaultCount = order.entries.filter(entry => !latestKeys.has(entryKey(entry))).length
      check(defaultKeys.size === order.entries.length && [...defaultKeys].every(key => latestKeys.has(key)), 'self_latest_defaults_mismatch')
      report.sourceDefaults = [...groups.values()].map(items => {
        const keys = new Set(items.map(entryKey))
        return {kind: items[0].source.kind, provider: items[0].provider, latest: latest.filter(item => keys.has(entryKey(item))).map(item => ({model: item.model, harness: item.harness})), defaults: order.entries.filter(item => keys.has(entryKey(item))).map(item => ({model: item.model, harness: item.harness}))}
      })
      check(same(before, candidates.map(entryKey)), 'self_catalogue_mutated')
      report.defaultModels = order.entries.map(entry => entry.model)
      report.defaultSetMatchesLatest = true
      report.fullCatalogueUnchangedByRead = true
    })
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
  await pin()
  report.passed = true
} catch (error) {
  report.passed = false
  report.errorCode = error instanceof Error && CODES.has(error.message) ? error.message : stepCode
  process.exitCode = 1
} finally {
  const closed = await Promise.allSettled(shutdown.map(async close => close()))
  report.poolsClosed = closed.every(result => result.status === 'fulfilled')
  if (!report.poolsClosed) {
    report.passed = false
    report.errorCode ??= 'self_cleanup_failed'
    process.exitCode = 1
  }
  mkdirSync('issues-1515-self-report', { recursive: true })
  writeFileSync('issues-1515-self-report/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}
