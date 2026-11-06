import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const API = 'https://api.github.com'
const REPO_API = API + '/repos/' + REPOSITORY
const BRANCH_NAME = 'ops/issue1415-dispatch-managed-inspection'
const BRANCH = 'refs/heads/' + BRANCH_NAME
const WORKFLOW_FILE = 'issue1415-managed-inspection.yml'
const WORKFLOW_PATH = '.github/workflows/' + WORKFLOW_FILE
const CONTROLLER_PATH = '.github/workflows/issue1415-dispatch-managed-inspection.yml'
const SOURCE_RUN_ID = 42285115630
const SOURCE_JOB_ID = 128123815664
const SOURCE_SHA = 'c0c98baa3020a085652ee5f773310b6dfa412c5d'

// Bound only after the inspected workflow is reviewed and merged on main.
export const BINDING = Object.freeze({ driverSha: 'e6afbd3cde052a66c9451ac81a0b59fc5674f7ae' })
class ClosedError extends Error {
  constructor(code, { status = null, cause } = {}) {
    super(code, { cause }); this.code = code
    this.status = Number.isInteger(status) ? status : null
  }
}
function requireValue(value, code) { if (!value) throw new ClosedError(code) }
function positiveId(value) { return Number.isSafeInteger(value) && value > 0 }
export function assertBinding(binding) {
  requireValue(binding && /^[a-f0-9]{40}$/.test(binding.driverSha ?? ''), 'TARGET_UNBOUND')
}
function assertContext(env) {
  requireValue(env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REPOSITORY_ID === String(REPOSITORY_ID) &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(OWNER_ID) &&
    env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === BRANCH &&
    env.GITHUB_WORKFLOW_REF === REPOSITORY + '/' + CONTROLLER_PATH + '@' + BRANCH &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    positiveId(Number(env.GITHUB_RUN_ID)), 'CONTROLLER_CONTEXT_REJECTED')
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'GITHUB_TOKEN_MISSING')
}
function sameRepository(value) {
  return value?.id === REPOSITORY_ID && value.full_name === REPOSITORY &&
    value.owner?.id === OWNER_ID
}
export function validateSnapshot(snapshot, binding) {
  assertBinding(binding)
  requireValue(snapshot.main?.ref === 'refs/heads/main' &&
    snapshot.main.object?.type === 'commit' && snapshot.main.object.sha === binding.driverSha,
  'DRIVER_MAIN_CHANGED')
  requireValue(snapshot.issue?.number === 1415 && snapshot.issue.state === 'open' &&
    snapshot.issue.repository_url === REPO_API && !snapshot.issue.pull_request, 'ISSUE_NOT_OPEN')
  requireValue(positiveId(snapshot.workflow?.id) && snapshot.workflow.path === WORKFLOW_PATH &&
    snapshot.workflow.state === 'active', 'WORKFLOW_MISMATCH')
  const run = snapshot.source
  requireValue(run?.id === SOURCE_RUN_ID && run.run_attempt === 1 &&
    sameRepository(run.repository) && sameRepository(run.head_repository) &&
    run.head_branch === 'main' && run.head_sha === SOURCE_SHA &&
    run.path === '.github/workflows/issue1415-deployed-production.yml' &&
    run.workflow_id === 409730660 && run.event === 'workflow_dispatch' &&
    run.status === 'completed' && run.conclusion === 'failure', 'SOURCE_RUN_MISMATCH')
  const jobs = snapshot.jobs
  requireValue(jobs?.total_count === 1 && Array.isArray(jobs.jobs) && jobs.jobs.length === 1 &&
    jobs.jobs[0].id === SOURCE_JOB_ID && jobs.jobs[0].run_id === SOURCE_RUN_ID &&
    jobs.jobs[0].head_sha === SOURCE_SHA && jobs.jobs[0].status === 'completed' &&
    jobs.jobs[0].conclusion === 'failure', 'SOURCE_JOB_MISMATCH')
}
async function discard(response) {
  try { await response.body?.cancel() } catch { /* Never retain response content. */ }
}
async function readJson(response, maximumBytes) {
  requireValue(response.body !== null, 'EMPTY_RESPONSE')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks = []
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      requireValue(bytes <= maximumBytes, 'RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(part.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (cause) {
    try { await reader.cancel() } catch { /* Preserve the original error. */ }
    if (cause instanceof ClosedError) throw cause
    throw new ClosedError('RESPONSE_JSON_INVALID', { cause })
  } finally { reader.releaseLock() }
}

// Synthetic tests inject HTTP and environment. The real CLI takes no arguments.
export async function requestManagedInspectionDispatch({
  binding = BINDING, env = process.env, fetchImpl = fetch,
} = {}) {
  const report = {
    schemaVersion: 1, kind: 'normal-managed-inspection-dispatch',
    expectedDriverSha: binding?.driverSha ?? null,
    sourceRunId: SOURCE_RUN_ID, sourceRunAttempt: 1, sourceJobId: SOURCE_JOB_ID,
    result: 'blocked', code: null, httpStatus: null,
    guardsPassed: false, postAttempted: false, workflowRunId: null,
    businessExecutionVerified: false, ownerRequests: 0, modelCalls: 0, sdkMutations: 0,
  }
  try {
    assertBinding(binding); assertContext(env)
    const headers = {
      Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2026-03-10',
    }
    async function get(url) {
      requireValue(new URL(url).origin === API, 'REQUEST_ORIGIN_REJECTED')
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers, signal: AbortSignal.timeout(15_000),
        })
      } catch (cause) { throw new ClosedError('READ_TRANSPORT_FAILED', { cause }) }
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        await discard(response)
        throw new ClosedError('READ_RESPONSE_REJECTED', { status: response.status })
      }
      return readJson(response, 131_072)
    }
    const workflowUrl = REPO_API + '/actions/workflows/' + WORKFLOW_FILE
    const urls = [
      REPO_API + '/git/ref/heads/main', REPO_API + '/issues/1415', workflowUrl,
      REPO_API + '/actions/runs/' + SOURCE_RUN_ID,
      REPO_API + '/actions/runs/' + SOURCE_RUN_ID + '/attempts/1/jobs?per_page=100',
    ]
    async function snapshot() {
      const values = await Promise.all(urls.map(url => get(url)))
      return Object.fromEntries(['main', 'issue', 'workflow', 'source', 'jobs']
        .map((name, index) => [name, values[index]]))
    }
    validateSnapshot(await snapshot(), binding)
    validateSnapshot(await snapshot(), binding)
    report.guardsPassed = true; report.postAttempted = true
    let response
    try {
      response = await fetchImpl(workflowUrl + '/dispatches', {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { source_run_id: String(SOURCE_RUN_ID) },
          return_run_details: true }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (cause) {
      report.result = 'request_uncertain'
      throw new ClosedError('DISPATCH_TRANSPORT_UNCERTAIN', { cause })
    }
    report.httpStatus = response.status
    if (response.status !== 200 || response.redirected ||
      (response.url && response.url !== workflowUrl + '/dispatches')) {
      await discard(response)
      throw new ClosedError('DISPATCH_NOT_ACCEPTED', { status: response.status })
    }
    const returned = await readJson(response, 8_192)
    requireValue(positiveId(returned.workflow_run_id) &&
      returned.run_url === REPO_API + '/actions/runs/' + returned.workflow_run_id &&
      returned.html_url === 'https://github.com/' + REPOSITORY + '/actions/runs/' + returned.workflow_run_id,
    'DISPATCH_RUN_DETAILS_INVALID')
    report.result = 'request_accepted'; report.code = 'DISPATCH_ACCEPTED'
    report.workflowRunId = returned.workflow_run_id
    // The child validates its own real main/workflow_dispatch identity and source
    // report before reading the existing platform token. Acceptance is not proven here.
  } catch (error) {
    if (report.postAttempted && report.result !== 'request_uncertain') report.result = 'failed'
    report.code = error instanceof ClosedError ? error.code : 'INTERNAL_FAILURE'
    if (error instanceof ClosedError && error.status !== null) report.httpStatus = error.status
  }
  return report
}
async function main() {
  requireValue(process.argv.length === 2, 'ARGUMENTS_REJECTED')
  const report = await requestManagedInspectionDispatch()
  await mkdir('managed-inspection-dispatch-report', { recursive: true, mode: 0o700 })
  await writeFile('managed-inspection-dispatch-report/result.json',
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({
    result: report.result, code: report.code, httpStatus: report.httpStatus,
    postAttempted: report.postAttempted, workflowRunId: report.workflowRunId,
    businessExecutionVerified: false, ownerRequests: 0, modelCalls: 0, sdkMutations: 0,
  }))
  if (report.result !== 'request_accepted') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ result: 'failed', code: 'CONTROLLER_FAILURE' }))
    process.exitCode = 1
  })
}
