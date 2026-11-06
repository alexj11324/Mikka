// Explicit future invocation only. Always reuse ready receipts; never run setup,
// choose a model, change shares, or recreate a workspace.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { validateFixtureReceipt, OUTPUT_DIR } from './coordinator-fixtures.mjs'
import { observeVersion } from './phase1.mjs'

const phases = ['cache', 'cache-live', 'tool', 'group-public']
const fail = code => { throw new Error(code) }
export function validateContinuation(value, receipt) {
  const keys = ['schemaVersion', 'enabled', 'phase', 'expectedSha', 'fixtureRunKey', 'workspaceId',
    'fixtureReceipt', 'fixtureReceiptSha256', 'cacheTurns', 'liveTabs', 'delayOneReturnedResult', 'groupBoundary']
  if (value?.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !phases.includes(value.phase) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    !(value.expectedSha === null && !value.enabled || /^[0-9a-f]{40}$/.test(value.expectedSha ?? '')) ||
    !/^receipts\/[a-z0-9-]+\.json$/.test(value.fixtureReceipt ?? '') || !/^[0-9a-f]{64}$/.test(value.fixtureReceiptSha256 ?? '') ||
    ![2, 3].includes(value.cacheTurns) || ![2, 3].includes(value.liveTabs) || typeof value.delayOneReturnedResult !== 'boolean' ||
    !['responding_bot', 'after_send'].includes(value.groupBoundary)) fail('continuation_invalid')
  validateFixtureReceipt(receipt, { ready: true })
  if (receipt.workspace.id !== value.workspaceId || receipt.runKey !== value.fixtureRunKey) fail('continuation_scope_invalid')
  return value
}

function loadInputs() {
  const config = JSON.parse(readFileSync(new URL('./control/continue.json', import.meta.url), 'utf8'))
  if (!/^receipts\/[a-z0-9-]+\.json$/.test(config.fixtureReceipt ?? '')) fail('continuation_invalid')
  const raw = readFileSync(new URL('./' + config.fixtureReceipt, import.meta.url))
  if (raw.length > 200_000 || createHash('sha256').update(raw).digest('hex') !== config.fixtureReceiptSha256) fail('continuation_receipt_invalid')
  const receipt = JSON.parse(raw.toString('utf8'))
  validateContinuation(config, receipt)
  return { config, receipt }
}

async function actualDriver(phase) {
  if (phase === 'cache') return (await import('./coordinator-cache-turns.mjs')).runCacheTurns
  if (phase === 'cache-live') return (await import('./live-cache-turns.mjs')).runLiveCacheTurns
  if (phase === 'tool') return (await import('./coordinator-tool-stop.mjs')).runToolStop
  if (phase === 'group-public') return (await import('./group-stop.mjs')).runGroupStop
  fail('continuation_invalid')
}

export async function runContinuation(key, { config, receipt, env = process.env, fetchImpl = globalThis.fetch,
  driver = null, checkpoint = true } = {}) {
  validateContinuation(config, receipt)
  if (!config.enabled) fail('continuation_disabled')
  if (!['haiku', 'luna'].includes(key)) fail('fixture_key_invalid')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-continuation', case: config.phase,
    fixtureKey: key, fixtureRunKey: config.fixtureRunKey, workspaceId: config.workspaceId,
    applicationSha: config.expectedSha, sourceReceiptSha256: config.fixtureReceiptSha256,
    status: 'failed', attempted: false, setupWrites: 0, modelSelectionWrites: 0, shareWrites: 0,
    startedAt: new Date().toISOString(), observation: null }
  const configuredEnv = { ...env, MIKKA_ACCEPTANCE_SHA: config.expectedSha, MIKKA_FIXTURE_KIND: key,
    MIKKA_CACHE_TURNS: String(config.cacheTurns), MIKKA_LIVE_TABS: String(config.liveTabs),
    MIKKA_LIVE_DELAY_ONE_RESULT: config.delayOneReturnedResult ? '1' : '0', MIKKA_GROUP_STOP_BOUNDARY: config.groupBoundary }
  try {
    report.before = await observeVersion(config.expectedSha, fetchImpl)
    if (!report.before.matches) fail('continuation_version_mismatch')
    const execute = driver ?? await actualDriver(config.phase)
    report.attempted = true
    report.observation = await execute({ env: configuredEnv, fixtureReceipt: receipt, checkpoint })
    const wanted = config.phase === 'group-public' ? 'stop_evidence_captured' : 'observed'
    if (report.observation?.status !== wanted) fail('continuation_observation_failed')
    report.status = 'observed'
  } catch (error) {
    report.error = ['continuation_version_mismatch', 'continuation_observation_failed'].includes(error?.message) ? error.message : 'continuation_failed'
  } finally {
    report.after = await observeVersion(config.expectedSha, fetchImpl)
    report.applicationVersionStable = report.before?.matches === true && report.after.matches === true
    if (!report.applicationVersionStable) { report.status = 'failed'; report.versionError = 'continuation_version_mismatch' }
    report.finishedAt = new Date().toISOString()
    if (checkpoint) {
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(`${OUTPUT_DIR}/continuation-${config.phase}-${key}-${config.expectedSha.slice(0, 8)}.json`, JSON.stringify(report, null, 2) + '\n')
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { config, receipt } = loadInputs()
    if (process.argv[2] === 'control') {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${config.enabled}\nphase=${config.phase}\n`)
      console.log(JSON.stringify({ issue: 1506, phase: config.phase, enabled: config.enabled,
        applicationSha: config.expectedSha, receiptVerified: true, setupWrites: 0 }))
    } else if (process.argv[2] === 'run') {
      const report = await runContinuation(process.argv[3], { config, receipt })
      console.log(JSON.stringify(report)); if (report.status !== 'observed') process.exitCode = 1
    } else fail('continuation_command_invalid')
  } catch { console.log(JSON.stringify({ issue: 1506, phase: 'alex-continuation', status: 'failed', error: 'continuation_input_invalid' })); process.exitCode = 1 }
}
