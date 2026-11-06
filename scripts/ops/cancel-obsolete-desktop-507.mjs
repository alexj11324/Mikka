import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const API = 'https://api.github.com'
const REPO_API = API + '/repos/' + REPOSITORY
const BRANCH = 'refs/heads/ops/issue1415-cancel-obsolete-desktop-507'
const DESKTOP_PATH = '.github/workflows/desktop-release.yml'

export const BINDING = Object.freeze({
  applicationSha: '565060241723fc985700b21be2c1c0cb3d6de3fc',
  targetRunId: 42262599697,
  targetSha: '9c1418c9bb6c3f4140145f7e9c26b4b7a1cf28cd',
  targetNumber: 507,
  replacementRunId: 42264192668,
  replacementNumber: 508,
  desktopWorkflowId: 401090101,
})
const ACTIVE = ['queued', 'requested', 'waiting', 'pending', 'in_progress']
const PUBLISH_STEP = 'Run softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65'
class ClosedError extends Error {
  constructor(code, status = null) {
    super(code)
    this.code = code
    this.status = Number.isInteger(status) ? status : null
  }
}
function requireValue(value, code) { if (!value) throw new ClosedError(code) }
export function assertBinding(binding) {
  requireValue(binding && Object.entries(BINDING).every(([key, value]) =>
    binding[key] === value), 'BINDING_MISMATCH')
}
function assertContext(env) {
  requireValue(env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REPOSITORY_ID === String(REPOSITORY_ID) &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(OWNER_ID) &&
    env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === BRANCH &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    Number.isSafeInteger(Number(env.GITHUB_RUN_ID)), 'CONTROLLER_CONTEXT_REJECTED')
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'GITHUB_TOKEN_MISSING')
}
function sameRepository(repository) {
  return repository?.id === REPOSITORY_ID && repository.full_name === REPOSITORY &&
    repository.owner?.id === OWNER_ID
}
function assertMain(main, binding) {
  requireValue(main?.ref === 'refs/heads/main' && main.object?.type === 'commit' &&
    main.object.sha === binding.applicationSha, 'MAIN_CHANGED')
}
function assertIssue(issue) {
  requireValue(issue?.number === 1415 && issue.state === 'open' &&
    issue.repository_url === REPO_API && !issue.pull_request, 'ISSUE_NOT_OPEN')
}
function assertRun(run, binding, replacement) {
  requireValue(run?.id === (replacement ? binding.replacementRunId : binding.targetRunId) &&
    sameRepository(run.repository) && sameRepository(run.head_repository) &&
    run.workflow_id === binding.desktopWorkflowId && run.path === DESKTOP_PATH &&
    run.head_branch === 'main' &&
    run.head_sha === (replacement ? binding.applicationSha : binding.targetSha) &&
    run.event === (replacement ? 'push' : 'workflow_dispatch') &&
    run.run_number === (replacement ? binding.replacementNumber : binding.targetNumber) &&
    run.run_attempt === 1, replacement ? 'REPLACEMENT_IDENTITY_MISMATCH' : 'TARGET_IDENTITY_MISMATCH')
  requireValue((replacement ? ['queued', 'pending', 'in_progress'] : ACTIVE).includes(run.status) &&
    run.conclusion === null, replacement ? 'REPLACEMENT_NOT_ACTIVE' : 'TARGET_NOT_ACTIVE')
}
function assertWorkflow(workflow, binding) {
  requireValue(workflow?.id === binding.desktopWorkflowId && workflow.path === DESKTOP_PATH &&
    workflow.state === 'active', 'DESKTOP_WORKFLOW_MISMATCH')
}
function assertBeforePublication(value, binding) {
  requireValue(Array.isArray(value?.jobs) && value.total_count === value.jobs.length &&
    value.jobs.length >= 2 && value.jobs.length <= 3, 'JOBS_INCOMPLETE')
  const names = new Set()
  for (const job of value.jobs) {
    requireValue(job.run_id === binding.targetRunId && job.run_attempt === 1 &&
      job.head_sha === binding.targetSha && job.head_branch === 'main' &&
      ['preflight', 'macos', 'release'].includes(job.name) && !names.has(job.name) &&
      Array.isArray(job.steps), 'JOB_IDENTITY_MISMATCH')
    names.add(job.name)
    for (const step of job.steps) {
      if (step.name === PUBLISH_STEP) {
        requireValue(step.status === 'pending' && step.conclusion === null &&
          step.started_at == null && step.completed_at == null, 'PUBLICATION_ALREADY_STARTED')
      }
    }
    if (job.name === 'release') {
      // The release job itself must still be unstarted. Even a failed publish
      // can have written resources, so absence of success is never sufficient.
      requireValue(['queued', 'pending', 'waiting'].includes(job.status) &&
        job.conclusion === null && job.started_at == null && job.completed_at == null &&
        job.steps.every(step => step.status === 'pending' && step.conclusion === null &&
          step.started_at == null && step.completed_at == null), 'RELEASE_ALREADY_STARTED')
    }
  }
  requireValue(names.has('preflight') && names.has('macos'), 'JOBS_INCOMPLETE')
}
export function validateSnapshot(snapshot, binding = BINDING) {
  assertBinding(binding)
  assertMain(snapshot.main, binding)
  assertIssue(snapshot.issue)
  assertWorkflow(snapshot.workflow, binding)
  assertRun(snapshot.target, binding, false)
  assertRun(snapshot.replacement, binding, true)
  assertBeforePublication(snapshot.jobs, binding)
}
async function cancelBody(response) {
  try { await response.body?.cancel() } catch { /* Never retain response content. */ }
}
async function readJson(response) {
  requireValue(response.body !== null, 'EMPTY_RESPONSE')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks = []
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      requireValue(bytes <= 131_072, 'RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    try { await reader.cancel() } catch { /* Preserve the closed error. */ }
    if (error instanceof ClosedError) throw error
    throw new ClosedError('RESPONSE_JSON_INVALID')
  } finally {
    reader.releaseLock()
  }
}

// Test-only dependency injection. CLI source/workflow/run identities are fixed and
// cannot be selected by arguments or environment variables.
export async function requestObsoleteCancellation({
  binding = BINDING, env = process.env, fetchImpl = fetch,
} = {}) {
  const report = {
    schemaVersion: 1, kind: 'normal-obsolete-desktop-cancel',
    applicationSha: BINDING.applicationSha, targetRunId: BINDING.targetRunId,
    targetSha: BINDING.targetSha, targetNumber: BINDING.targetNumber,
    replacementRunId: BINDING.replacementRunId, replacementNumber: BINDING.replacementNumber,
    desktopWorkflowId: BINDING.desktopWorkflowId,
    result: 'blocked', code: null, httpStatus: null,
    guardsPassed: false, postAttempted: false,
    cancelledVerified: false, publishedVerified: false,
  }
  try {
    assertBinding(binding)
    assertContext(env)
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
    }
    async function get(url) {
      requireValue(new URL(url).origin === API, 'REQUEST_ORIGIN_REJECTED')
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers, signal: AbortSignal.timeout(15_000),
        })
      } catch { throw new ClosedError('READ_TRANSPORT_FAILED') }
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        await cancelBody(response)
        throw new ClosedError('READ_RESPONSE_REJECTED', response.status)
      }
      return readJson(response)
    }
    const workflowUrl = REPO_API + '/actions/workflows/' + binding.desktopWorkflowId
    const targetUrl = REPO_API + '/actions/runs/' + binding.targetRunId
    const urls = [
      REPO_API + '/git/ref/heads/main', REPO_API + '/issues/1415', workflowUrl,
      targetUrl, REPO_API + '/actions/runs/' + binding.replacementRunId,
      targetUrl + '/jobs?filter=latest&per_page=100',
    ]
    async function snapshot() {
      const values = await Promise.all(urls.map(url => get(url)))
      return Object.fromEntries(['main', 'issue', 'workflow', 'target', 'replacement', 'jobs']
        .map((name, index) => [name, values[index]]))
    }
    validateSnapshot(await snapshot(), binding)
    // Re-read every mutable gate just before the only normal cancel request.
    // These observations are not atomic with cancellation: a GitHub conflict
    // or uncertain transport is preserved and never retried automatically.
    validateSnapshot(await snapshot(), binding)
    report.guardsPassed = true
    report.postAttempted = true
    let response
    try {
      response = await fetchImpl(targetUrl + '/cancel', {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      report.result = 'request_uncertain'
      throw new ClosedError('CANCEL_TRANSPORT_UNCERTAIN')
    }
    report.httpStatus = response.status
    await cancelBody(response)
    requireValue(response.status === 202 && !response.redirected &&
      (!response.url || response.url === targetUrl + '/cancel'), 'CANCEL_NOT_ACCEPTED')
    report.result = 'request_accepted'
    report.code = 'CANCEL_ACCEPTED'
  } catch (error) {
    if (report.postAttempted && report.result !== 'request_uncertain') report.result = 'failed'
    report.code = error instanceof ClosedError ? error.code : 'INTERNAL_FAILURE'
    if (error instanceof ClosedError && error.status !== null) report.httpStatus = error.status
  }
  return report
}
async function main() {
  requireValue(process.argv.length === 2, 'ARGUMENTS_REJECTED')
  const report = await requestObsoleteCancellation()
  await mkdir('obsolete-desktop-cancel-report', { recursive: true, mode: 0o700 })
  await writeFile('obsolete-desktop-cancel-report/result.json', JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({
    result: report.result, code: report.code, httpStatus: report.httpStatus,
    postAttempted: report.postAttempted, cancelledVerified: false, publishedVerified: false,
  }))
  if (report.result !== 'request_accepted') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ result: 'failed', code: 'CONTROLLER_FAILURE' }))
    process.exitCode = 1
  })
}
