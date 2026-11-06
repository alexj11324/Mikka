// Deliberately invoked by the control file, never by implementation-only pushes.
// A failed baseline remains failed; its independent companion may still run.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setupWorkspace, OUTPUT_DIR } from './workspace-setup.mjs'
import { runFixtureSetup } from './coordinator-fixtures.mjs'
import { runBaseline } from './coordinator-baseline.mjs'

const STEPS = new Set(['workspace', 'fixtures', 'baseline-haiku', 'baseline-luna'])
const fail = code => { throw new Error(code) }
export function validateInvocation(value) {
  if (value?.schemaVersion !== 1 || value.phase !== 'setup-and-1490-baseline' ||
    !/^[0-9a-f]{40}$/.test(value.expectedSha ?? '') || !/^[a-z0-9][a-z0-9-]{0,35}$/.test(value.fixtureRunKey ?? '') ||
    Object.keys(value).sort().join(',') !== 'expectedSha,fixtureRunKey,phase,schemaVersion') fail('phase_invocation_invalid')
  return value
}

export async function observeVersion(expectedSha, fetchImpl = globalThis.fetch) {
  const started = performance.now()
  try {
    const response = await fetchImpl('https://app.aspectlylabs.com/mikka/api/version', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'cache-control': 'no-cache', accept: 'application/json' },
    })
    let value
    try { value = await response.json() } catch { value = null }
    const build = /^[0-9a-f]{40}$/.test(value?.build ?? '') ? value.build : null
    return { status: response.status, build, matches: response.ok && build === expectedSha,
      durationMs: Math.round(performance.now() - started) }
  } catch { return { status: null, build: null, matches: false, error: 'version_read_failed', durationMs: Math.round(performance.now() - started) } }
}

export async function runPhase(step, { invocation, env = process.env, fetchImpl = globalThis.fetch,
  drivers = { workspace: setupWorkspace, fixtures: runFixtureSetup, baseline: runBaseline }, checkpoint = true } = {}) {
  const config = validateInvocation(invocation)
  if (!STEPS.has(step)) fail('phase_step_invalid')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-phase1', step, status: 'failed',
    applicationSha: config.expectedSha, fixtureRunKey: config.fixtureRunKey, attempted: false,
    startedAt: new Date().toISOString(), before: null, after: null }
  const configuredEnv = { ...env, MIKKA_ACCEPTANCE_SHA: config.expectedSha, MIKKA_FIXTURE_RUN_KEY: config.fixtureRunKey,
    MIKKA_WORKSPACE_RECEIPT: OUTPUT_DIR + '/workspace.json',
    MIKKA_FIXTURE_RECEIPT: OUTPUT_DIR + '/coordinator-fixtures.json',
    ...(step.startsWith('baseline-') ? { MIKKA_FIXTURE_KIND: step.slice('baseline-'.length) } : {}) }
  try {
    report.before = await observeVersion(config.expectedSha, fetchImpl)
    if (!report.before.matches) fail('phase_version_mismatch')
    report.attempted = true
    const outcome = step === 'workspace' ? await drivers.workspace({ env: configuredEnv })
      : step === 'fixtures' ? await drivers.fixtures({ env: configuredEnv })
      : await drivers.baseline({ env: configuredEnv })
    report.observationStatus = outcome.status
    if (step.startsWith('baseline-')) {
      // Preserve the complete, sanitized observation even if cancellation is defective.
      if (checkpoint) {
        mkdirSync(OUTPUT_DIR, { recursive: true })
        writeFileSync(`${OUTPUT_DIR}/coordinator-${step}.json`, JSON.stringify(outcome, null, 2) + '\n')
      }
    }
    // Existing sanitized receipts include the fixture ids needed for later bounded phases.
    console.log(JSON.stringify(outcome))
    if (outcome.status !== (step.startsWith('baseline-') ? 'observed' : 'ready')) fail('phase_observation_failed')
    report.status = 'observed'
  } catch (error) {
    report.error = ['phase_version_mismatch', 'phase_observation_failed'].includes(error?.message) ? error.message : 'phase_failed'
  } finally {
    // Also record the post-version on failure, without changing or repeating any model request.
    report.after = await observeVersion(config.expectedSha, fetchImpl)
    report.applicationVersionStable = report.before?.matches === true && report.after.matches === true
    if (!report.applicationVersionStable) { report.status = 'failed'; report.versionError = 'phase_version_mismatch' }
    report.finishedAt = new Date().toISOString()
    if (checkpoint) {
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(`${OUTPUT_DIR}/phase-${step}.json`, JSON.stringify(report, null, 2) + '\n')
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const invocation = JSON.parse(readFileSync(new URL('./control/invocation.json', import.meta.url), 'utf8'))
    const report = await runPhase(process.argv[2], { invocation })
    console.log(JSON.stringify(report))
    if (report.status !== 'observed') process.exitCode = 1
  } catch { console.log(JSON.stringify({ issue: 1506, phase: 'alex-phase1', status: 'failed', error: 'phase_invocation_invalid' })); process.exitCode = 1 }
}
