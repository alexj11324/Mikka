// Explicit recovery of the two already-created, already-selected fixtures only.
// Source receipts are immutable; the normal action layer is read-only in resume.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { OUTPUT_DIR, validateWorkspaceReceipt } from './workspace-setup.mjs'
import { runFixtureSetup, validateFixtureReceipt } from './coordinator-fixtures.mjs'
import { runBaseline } from './coordinator-baseline.mjs'
import { observeVersion } from './phase1.mjs'

const fail = code => { throw new Error(code) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const steps = new Set(['fixtures', 'baseline-haiku', 'baseline-luna'])
export function validateResumeInvocation(value, workspace, fixtures) {
  const keys = ['schemaVersion', 'phase', 'expectedSha', 'fixtureRunKey', 'workspaceId', 'workspaceReceipt',
    'workspaceReceiptSha256', 'fixtureReceipt', 'fixtureReceiptSha256']
  if (value?.schemaVersion !== 1 || value.phase !== 'resume-and-1490-baseline' ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',') || !/^[0-9a-f]{40}$/.test(value.expectedSha ?? '') ||
    !UUID.test(value.workspaceId ?? '') || !/^[a-z0-9][a-z0-9-]{0,35}$/.test(value.fixtureRunKey ?? '') ||
    ![value.workspaceReceipt, value.fixtureReceipt].every(path => /^receipts\/[a-z0-9-]+\.json$/.test(path ?? '')) ||
    ![value.workspaceReceiptSha256, value.fixtureReceiptSha256].every(hash => /^[0-9a-f]{64}$/.test(hash ?? ''))) fail('resume_invocation_invalid')
  validateWorkspaceReceipt(workspace); validateFixtureReceipt(fixtures)
  if ([workspace, fixtures].some(receipt => receipt.runKey !== value.fixtureRunKey || receipt.workspace.id !== value.workspaceId) ||
    JSON.stringify(workspace.workspace) !== JSON.stringify(fixtures.workspace) ||
    fixtures.fixtures.some(row => row.createAttempted !== true || row.selectionAttempted !== true ||
      !UUID.test(row.botId ?? '') || !UUID.test(row.optionId ?? ''))) fail('resume_receipt_invalid')
  return value
}

function readChecked(path, expectedHash) {
  if (!/^receipts\/[a-z0-9-]+\.json$/.test(path ?? '') || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) fail('resume_invocation_invalid')
  const bytes = readFileSync(new URL('./' + path, import.meta.url))
  if (bytes.length > 200_000 || createHash('sha256').update(bytes).digest('hex') !== expectedHash) fail('resume_receipt_invalid')
  return JSON.parse(bytes.toString('utf8'))
}

export async function runResumePhase(step, { invocation, workspaceReceipt, fixtureReceipt, env = process.env,
  fetchImpl = globalThis.fetch, drivers = { fixtures: runFixtureSetup, baseline: runBaseline }, checkpoint = true } = {}) {
  const config = validateResumeInvocation(invocation, workspaceReceipt, fixtureReceipt)
  if (!steps.has(step)) fail('resume_step_invalid')
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-resume-baseline', step, status: 'failed',
    applicationSha: config.expectedSha, fixtureRunKey: config.fixtureRunKey, workspaceId: config.workspaceId,
    sourceReceiptSha256: config.fixtureReceiptSha256, attempted: false, startedAt: new Date().toISOString() }
  const configuredEnv = { ...env, MIKKA_ACCEPTANCE_SHA: config.expectedSha, MIKKA_FIXTURE_RECEIPT: OUTPUT_DIR + '/coordinator-fixtures.json',
    ...(step.startsWith('baseline-') ? { MIKKA_FIXTURE_KIND: step.slice('baseline-'.length) } : {}) }
  try {
    report.before = await observeVersion(config.expectedSha, fetchImpl)
    if (!report.before.matches) fail('resume_version_mismatch')
    report.attempted = true
    const outcome = step === 'fixtures'
      ? await drivers.fixtures({ env: configuredEnv, mode: 'resume', receipt: fixtureReceipt })
      : await drivers.baseline({ env: configuredEnv })
    report.observationStatus = outcome.status
    if (checkpoint && step.startsWith('baseline-')) {
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(`${OUTPUT_DIR}/coordinator-${step}.json`, JSON.stringify(outcome, null, 2) + '\n')
    }
    console.log(JSON.stringify(outcome))
    if (outcome.status !== (step === 'fixtures' ? 'ready' : 'observed')) fail('resume_observation_failed')
    report.status = 'observed'
  } catch (error) {
    report.error = ['resume_version_mismatch', 'resume_observation_failed'].includes(error?.message) ? error.message : 'resume_failed'
  } finally {
    report.after = await observeVersion(config.expectedSha, fetchImpl)
    report.applicationVersionStable = report.before?.matches === true && report.after.matches === true
    if (!report.applicationVersionStable) { report.status = 'failed'; report.versionError = 'resume_version_mismatch' }
    report.finishedAt = new Date().toISOString()
    if (checkpoint) {
      mkdirSync(OUTPUT_DIR, { recursive: true })
      writeFileSync(`${OUTPUT_DIR}/resume-${step}.json`, JSON.stringify(report, null, 2) + '\n')
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const invocation = JSON.parse(readFileSync(new URL('./control/resume-baseline.json', import.meta.url), 'utf8'))
    const workspaceReceipt = readChecked(invocation.workspaceReceipt, invocation.workspaceReceiptSha256)
    const fixtureReceipt = readChecked(invocation.fixtureReceipt, invocation.fixtureReceiptSha256)
    const report = await runResumePhase(process.argv[2], { invocation, workspaceReceipt, fixtureReceipt })
    console.log(JSON.stringify(report)); if (report.status !== 'observed') process.exitCode = 1
  } catch { console.log(JSON.stringify({ issue: 1506, phase: 'alex-resume-baseline', status: 'failed', error: 'resume_invocation_invalid' })); process.exitCode = 1 }
}
