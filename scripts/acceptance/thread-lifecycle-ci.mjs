/** Main-only wiring for #1593. No artifact inputs, deployment mutation or URL overrides. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCurrentMain, waitForWebDeployment } from '../release/web-deploy.mjs'

export const REPOSITORY = 'alexj11324/Mikka'
export const RELEASE_WORKFLOW = '.github/workflows/e2b-official-runtime.yml'
export const RELEASE_NAME = 'E2B additive runtime release'
const ROOT = resolve(import.meta.dirname, '../..')
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const integer = value => Number.isSafeInteger(value) && value > 0
const PROVIDER_CASES = ['active-monitor', 'provider-request-deadline', 'provider-refusal', 'lost-pause-response', 'resume-monitor',
  'stale-epoch', 'stop-idempotence', 'end-idempotence']
const PROVIDER_SCOPE = Object.freeze({ realProviderRpc: true, injectedTransportFaults: true,
  naturalTimeoutExpiry: false, daemonAcceptance: false, subscriptionAcceptance: false, modelCalls: 0,
  resumeScope: 'provider-resume-to-controller-monitor', requestDeadlineScope: 'sdk-request-deadline-to-controller-recovery' })
const REQUEST_DEADLINE = Object.freeze({ operation: 'setTimeout', requestTimeoutMs: 1, retries: 0,
  errorName: 'TimeoutError', earlyReplayIo: 0, recovered: true })
const requestDeadlineProved = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(REQUEST_DEADLINE).every(([key, expected]) => value[key] === expected)
const RETIREMENT_FLAGS = ['restoredBeforeKill', 'restoredAfterKill', 'uploadClockAuthoritative', 'openRetentionRetained',
  'closedGraceRetained', 'missingCheckpointRetained', 'deviceTokenRevoked', 'automaticKillConfirmed', 'historyPreserved']
const retirementProved = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && value.scope === 'confirmed-checkpoint-to-automatic-retirement' && value.clock === 'controlled-paused-deadline'
  && /^[a-f0-9]{64}$/.test(value.checkpointSha256 ?? '') && RETIREMENT_FLAGS.every(key => value[key] === true)
  && ['requestedAt', 'observedAt'].every(key => typeof value[key] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[key]))
  && Number.isFinite(Date.parse(value.requestedAt)) && Number.isFinite(Date.parse(value.observedAt))
  && Date.parse(value.observedAt) >= Date.parse(value.requestedAt)
const retirementReceipt = value => ({ scope: value.scope, clock: value.clock, checkpointSha256: value.checkpointSha256,
  ...Object.fromEntries(RETIREMENT_FLAGS.map(key => [key, true])), requestedAt: value.requestedAt, observedAt: value.observedAt })
const QUESTION_RESUME_SCOPE = 'real_owner_factory_question_pause_resume_with_native_report'
const ISSUE_PENDING = ['external_wait_and_adjacent_stage_continuity', 'terminal_revoke_and_close_grace_retention',
  'provider_timeout_fault_injection', 'latency_and_cost_measurement']
const FAILURES = new Set(['context', 'trigger', 'workflow', 'upstream', 'jobs', 'checkout', 'not_selected',
  'github_unavailable', 'github_response', 'report_target', 'provider_report', 'incomplete', 'command'])
class LifecycleCIError extends Error {
  constructor(code, cause) { super('thread_lifecycle_ci:' + code, cause === undefined ? undefined : { cause }); this.code = code }
}
const require = (ok, code) => { if (!ok) throw new LifecycleCIError(code) }

/** The webhook is only a pointer. Every identity and attempt is checked against the API. */
export function expectedRelease(env, event) {
  require(env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REPOSITORY === REPOSITORY
    && env.GITHUB_REF === 'refs/heads/main', 'context')
  const run = event?.workflow_run
  require(integer(run?.id) && integer(run?.run_attempt) && integer(run?.workflow_id)
    && SHA.test(run?.head_sha ?? '') && run.name === RELEASE_NAME
    && run.status === 'completed' && run.conclusion === 'success'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main'
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY, 'trigger')
  require(env.EXPECTED_SOURCE_SHA === run.head_sha
    && env.EXPECTED_UPSTREAM_RUN_ID === String(run.id)
    && env.EXPECTED_UPSTREAM_RUN_ATTEMPT === String(run.run_attempt), 'trigger')
  return { sourceCommit: run.head_sha, runId: run.id, runAttempt: run.run_attempt, workflowId: run.workflow_id,
    event: run.event }
}

export function assertReleaseIdentity(expected, workflow, run) {
  require(workflow?.id === expected.workflowId && workflow.path === RELEASE_WORKFLOW
    && workflow.name === RELEASE_NAME && workflow.state === 'active', 'workflow')
  require(run?.id === expected.runId && run.run_attempt === expected.runAttempt
    && run.workflow_id === expected.workflowId && run.path === RELEASE_WORKFLOW && run.name === RELEASE_NAME
    && run.status === 'completed' && run.conclusion === 'success' && run.event === expected.event
    && ['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main'
    && run.head_sha === expected.sourceCommit && run.repository?.full_name === REPOSITORY
    && run.head_repository?.full_name === REPOSITORY, 'upstream')
}

/** Only lifecycle source/driver changes or an actually validated candidate spend money. */
export function lifecycleChanged(files) {
  return files.some(file => /^(?:lib\/cloud-computer\/thread-(?:machines|lifecycle(?:-provider|-due|-log)?)\.ts|workflows\/thread-machine\/[^/]+\.ts)$/.test(file)
    || /^scripts\/(?:acceptance\/thread-lifecycle(?:-ci)?(?:\.test)?\.mjs|e2b\/thread-lifecycle-(?:acceptance|archive)(?:\.test)?\.ts)$/.test(file)
    || file === '.github/workflows/thread-lifecycle-acceptance.yml')
}

export function selectRelease(expected, data, files) {
  require(Array.isArray(data?.jobs) && data.total_count === data.jobs.length && data.jobs.length > 0
    && data.jobs.length <= 100 && data.jobs.every(job => integer(job.id) && job.run_id === expected.runId
      && job.run_attempt === expected.runAttempt && job.head_sha === expected.sourceCommit
      && job.status === 'completed' && ['success', 'skipped'].includes(job.conclusion)), 'jobs')
  const job = (name, conclusion) => {
    const matches = data.jobs.filter(item => item.name === name)
    require(matches.length === 1 && matches[0].conclusion === conclusion, 'jobs')
    return matches[0].id
  }
  const jobs = { test: job('test', 'success'), check: job('check', 'success') }
  const nested = data.jobs.some(item => item.name === 'release / recheck')
  const prefix = nested ? 'release / ' : ''
  if (nested) jobs.recheck = job('release / recheck', 'success')
  const validated = data.jobs.some(item => item.name === prefix + 'validate / build')
  if (validated) {
    require(!data.jobs.some(item => item.name === prefix + 'validate'), 'jobs')
    jobs.validate = job(prefix + 'validate / build', 'success')
    jobs.awaitWeb = job(prefix + 'await-web', 'success')
    jobs.subscriptions = job(prefix + 'subscriptions', 'success')
    jobs.publish = job(prefix + 'publish / deploy', 'success')
    jobs.cleanup = job(prefix + 'cleanup', 'success')
  } else if (data.jobs.some(item => item.name === 'release')) {
    jobs.release = job('release', 'skipped')
    require(!nested && !data.jobs.some(item => /^(?:release \/ )?(?:validate|subscriptions|publish|cleanup)(?: \/|$)/.test(item.name)), 'jobs')
  } else {
    jobs.validate = job(prefix + 'validate', 'skipped')
    jobs.awaitWeb = job(prefix + 'await-web', 'skipped')
    jobs.subscriptions = job(prefix + 'subscriptions', 'skipped')
    jobs.publish = job(prefix + 'publish', 'skipped')
    jobs.cleanup = job(prefix + 'cleanup', 'skipped')
  }
  const relevant = lifecycleChanged(files)
  return { selected: relevant || validated, reason: validated ? 'validated_runtime' : relevant ? 'lifecycle_changes' : 'unrelated',
    runtime: validated ? 'validated_and_published' : 'unchanged_worker', jobs }
}

async function githubRead(path, { token, fetchImpl }) {
  require(typeof token === 'string' && token.length > 0, 'context')
  let response
  try {
    response = await fetchImpl('https://api.github.com/repos/' + REPOSITORY + path, {
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
  } catch (error) { throw new LifecycleCIError('github_unavailable', error) }
  require(response.ok, 'github_response')
  try { return await response.json() } catch (error) { throw new LifecycleCIError('github_response', error) }
}

export async function verifyRelease({ env, event, files, fetchImpl = fetch }) {
  const expected = expectedRelease(env, event), options = { token: env.GITHUB_TOKEN, fetchImpl }
  const workflow = await githubRead('/actions/workflows/e2b-official-runtime.yml', options)
  const run = await githubRead('/actions/runs/' + expected.runId, options)
  assertReleaseIdentity(expected, workflow, run)
  await assertCurrentMain({ expectedBuild: expected.sourceCommit, ...options })
  const data = await githubRead(`/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`, options)
  const selection = selectRelease(expected, data, files)
  // Reruns and a moving main invalidate the earlier response before credentials.
  assertReleaseIdentity(expected, workflow, await githubRead('/actions/runs/' + expected.runId, options))
  await assertCurrentMain({ expectedBuild: expected.sourceCommit, ...options })
  return { kind: 'thread-lifecycle-ci-attestation', sourceCommit: expected.sourceCommit,
    upstream: { runId: expected.runId, runAttempt: expected.runAttempt, workflowId: expected.workflowId }, ...selection }
}

function checkoutFiles(sourceCommit) {
  require(SHA.test(sourceCommit ?? ''), 'checkout')
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  require(git(['rev-parse', 'HEAD']) === sourceCommit && git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'checkout')
  // Owner merges are a single merge/squash commit; first-parent diff includes
  // the complete PR, not merely its last development commit. Missing history fails.
  return git(['diff', '--name-only', '--no-renames', sourceCommit + '^1', sourceCommit, '--']).split('\n').filter(Boolean)
}

function reportDirectory(env) {
  require(typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP), 'report_target')
  const temp = realpathSync(env.RUNNER_TEMP), distance = relative(ROOT, temp)
  require(distance.startsWith('..' + sep) || isAbsolute(distance), 'report_target')
  const directory = join(temp, 'thread-lifecycle-acceptance')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  require(realpathSync(directory) === directory, 'report_target')
  return directory
}

function writeReport(env, name, report) {
  writeFileSync(join(reportDirectory(env), name), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
function output(env, name, value) {
  require(typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT.length > 0, 'context')
  appendFileSync(env.GITHUB_OUTPUT, name + '=' + value + '\n')
}

export function assertAttestation(expected, proof) {
  require(proof?.kind === 'thread-lifecycle-ci-attestation' && proof.selected === true
    && proof.sourceCommit === expected.sourceCommit && proof.upstream?.runId === expected.runId
    && proof.upstream?.runAttempt === expected.runAttempt && proof.upstream?.workflowId === expected.workflowId
    && proof.web?.sourceCommit === expected.sourceCommit && proof.web.publicBuild === expected.sourceCommit
    && integer(proof.web.webRunId) && integer(proof.web.webAttempt), 'upstream')
}

/** The driver's closed stage error is emitted only after its finally confirmed cleanup.
 * Any preflight, import, malformed result, interruption or cleanup error lacks that receipt. */
export async function providerReceipt({ sourceCommit, run }) {
  require(SHA.test(sourceCommit ?? ''), 'provider_report')
  const base = { kind: 'thread-lifecycle-provider-acceptance', sourceCommit, scope: PROVIDER_SCOPE }
  try {
    const report = await run()
    require(report?.kind === base.kind && report.status === 'passed' && report.sourceCommit === sourceCommit
      && SHA.test(report.workerHash ?? '') && report.template === 'codex' && UUID.test(report.acceptance ?? '')
      && UUID.test(report.runId ?? '') && /^[a-zA-Z0-9_-]{1,100}$/.test(report.sandboxId ?? '')
      && report.subscriptionAcceptance === false && report.modelCalls === 0
      && report.resumeScope === PROVIDER_SCOPE.resumeScope
      && report.requestDeadlineScope === PROVIDER_SCOPE.requestDeadlineScope && requestDeadlineProved(report.requestDeadline)
      && retirementProved(report.retirement) && report.counters?.kill === 1
      && JSON.stringify(report.cases) === JSON.stringify(PROVIDER_CASES)
      && ['info', 'keepAlive', 'pause', 'kill'].every(key => Number.isSafeInteger(report.counters?.[key]) && report.counters[key] >= 0)
      && report.cleanup?.provider === 'confirmed_missing' && report.cleanup?.database === 'dropped', 'provider_report')
    return { ...base, status: 'passed', acceptance: report.acceptance, workerHash: report.workerHash,
      template: report.template, sandboxId: report.sandboxId, runId: report.runId, cases: [...PROVIDER_CASES],
      requestDeadline: { ...REQUEST_DEADLINE },
      retirement: retirementReceipt(report.retirement),
      counters: Object.fromEntries(['info', 'keepAlive', 'pause', 'kill'].map(key => [key, report.counters[key]])),
      cleanup: { status: 'passed', provider: 'confirmed_missing', database: 'dropped' } }
  } catch (error) {
    const stage = error instanceof Error && !(error instanceof AggregateError)
      ? /^thread_lifecycle_acceptance_failed:([a-z-]+)$/.exec(error.message)?.[1] : undefined
    const cleaned = ['database', 'create', ...PROVIDER_CASES].includes(stage)
    return { ...base, status: 'failed', code: cleaned ? 'case_failed_after_cleanup'
      : error instanceof AggregateError ? 'cleanup_failed' : 'cleanup_unconfirmed',
    ...(cleaned ? { stage } : {}), cleanup: { status: cleaned ? 'passed' : 'unconfirmed',
      ...(cleaned ? { receipt: 'driver_finally_completed' } : {}) } }
  }
}

export function completeEvidence(sourceCommit, provider, owner, outcomes) {
  const cases = owner?.cases
  const providerPassed = outcomes.provider === 'success' && provider?.sourceCommit === sourceCommit
    && provider.status === 'passed' && provider.cleanup?.status === 'passed'
    && provider.scope?.requestDeadlineScope === PROVIDER_SCOPE.requestDeadlineScope && requestDeadlineProved(provider.requestDeadline)
    && retirementProved(provider.retirement) && provider.counters?.kill === 1
    && JSON.stringify(provider.cases) === JSON.stringify(PROVIDER_CASES)
  const questionResumePassed = outcomes.owner === 'success' && owner?.sourceCommit === sourceCommit && owner.scope === QUESTION_RESUME_SCOPE
    && owner.issueAcceptance === 'incomplete' && owner.status === 'passed' && owner.cleanup?.status === 'passed'
    && Array.isArray(cases) && cases.length === 2
    && [['claude_code', 'claude-haiku-5-5'], ['codex', 'gpt-6-luna']].every(([harness, model]) =>
      cases.filter(item => item?.harness === harness && item.model === model && item.sourceCommit === sourceCommit
        && item.status === 'passed' && item.cleanup?.status === 'passed').length === 1)
  const passed = SHA.test(sourceCommit ?? '') && providerPassed && questionResumePassed
  return { kind: 'thread-lifecycle-question-resume-evidence', issue: 1593, sourceCommit,
    scope: 'provider_controller_faults_and_task_vm_question_resume', status: passed ? 'passed' : 'failed',
    issueAcceptance: 'incomplete', pending: ISSUE_PENDING.filter(item => item !== 'provider_timeout_fault_injection' || !providerPassed),
    providerIntegration: providerPassed ? 'passed' : 'incomplete',
    automaticRetirement: providerPassed ? 'passed' : 'incomplete',
    questionResume: questionResumePassed ? 'passed' : 'incomplete', providerScope: PROVIDER_SCOPE }
}

async function main(command, env) {
  require(['eligible', 'attest', 'provider', 'complete'].includes(command), 'command')
  require(SHA.test(env.EXPECTED_SOURCE_SHA ?? ''), 'context')
  if (command === 'complete') {
    const directory = reportDirectory(env)
    const read = name => { try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { return null } }
    const report = completeEvidence(env.EXPECTED_SOURCE_SHA, read('provider-report.json'), read('report.json'),
      { provider: env.PROVIDER_OUTCOME, owner: env.OWNER_OUTCOME })
    writeReport(env, 'summary.json', report)
    console.log(JSON.stringify(report))
    require(report.status === 'passed', 'incomplete')
    return
  }
  const files = checkoutFiles(env.EXPECTED_SOURCE_SHA)
  if (command === 'provider') {
    const expected = expectedRelease(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')))
    assertAttestation(expected, JSON.parse(readFileSync(join(reportDirectory(env), 'attestation.json'), 'utf8')))
    // Keep imports (and all possible driver errors) inside the receipt boundary.
    const report = await providerReceipt({ sourceCommit: env.EXPECTED_SOURCE_SHA, run: async () => {
      const { runThreadLifecycleAcceptance } = await import('../e2b/thread-lifecycle-acceptance.ts')
      return runThreadLifecycleAcceptance()
    } })
    writeReport(env, 'provider-report.json', report)
    output(env, 'cleanup-complete', report.cleanup.status === 'passed' ? 'true' : 'false')
    console.log(JSON.stringify(report))
    if (report.status !== 'passed') process.exitCode = 1
    return
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  let proof = await verifyRelease({ env, event, files })
  if (command === 'eligible') {
    output(env, 'selected', proof.selected ? 'true' : 'false')
    console.log(JSON.stringify(proof))
    return
  }
  require(proof.selected, 'not_selected')
  const web = await waitForWebDeployment({ expectedBuild: env.EXPECTED_SOURCE_SHA, token: env.GITHUB_TOKEN })
  proof = await verifyRelease({ env, event, files })
  require(proof.selected && web.sourceCommit === proof.sourceCommit && web.publicBuild === proof.sourceCommit, 'upstream')
  writeReport(env, 'attestation.json', { ...proof, web })
  console.log(JSON.stringify({ ...proof, web }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.length === 3 ? process.argv[2] : '', process.env).catch(error => {
    // HTTP/SDK bodies, credential values and nested causes never enter logs or artifacts.
    console.error(JSON.stringify({ kind: 'thread-lifecycle-ci', status: 'failed',
      code: error instanceof LifecycleCIError && FAILURES.has(error.code) ? error.code : 'guard_failed' }))
    process.exitCode = 1
  })
}
