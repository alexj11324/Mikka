import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const API = 'https://api.github.com'
const REPO_API = API + '/repos/' + REPOSITORY
const BRANCH = 'refs/heads/ops/issue1415-desktop-dispatch-9c'
const DESKTOP_PATH = '.github/workflows/desktop-release.yml'
const WEB_PATH = '.github/workflows/web-deploy.yml'

export const BINDING = Object.freeze({
  applicationSha: '9c1418c9bb6c3f4140145f7e9c26b4b7a1cf28cd',
  webRunId: 42261069936,
  desktopWorkflowId: 401090101,
})
const PAYLOAD = Object.freeze({ ref: 'main', inputs: Object.freeze({ skip_notarization: false }) })
class ClosedError extends Error {
  constructor(code, status = null) {
    super(code)
    this.code = code
    this.status = Number.isInteger(status) ? status : null
  }
}
function requireValue(value, code) { if (!value) throw new ClosedError(code) }
export function assertBinding(binding) {
  requireValue(binding?.applicationSha === BINDING.applicationSha &&
    binding?.webRunId === BINDING.webRunId &&
    binding?.desktopWorkflowId === BINDING.desktopWorkflowId, 'BINDING_MISMATCH')
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
function assertWeb(run, binding) {
  requireValue(run?.id === binding.webRunId && sameRepository(run.repository) &&
    sameRepository(run.head_repository) && run.head_branch === 'main' &&
    run.head_sha === binding.applicationSha && run.path === WEB_PATH && run.event === 'push',
  'WEB_RUN_IDENTITY_MISMATCH')
  const active = ['queued', 'requested', 'waiting', 'pending', 'in_progress'].includes(run.status)
  requireValue((active && run.conclusion === null) ||
    (run.status === 'completed' && run.conclusion === 'success'), 'WEB_RUN_NOT_ELIGIBLE')
}
function assertWorkflow(workflow, binding) {
  requireValue(workflow?.id === binding.desktopWorkflowId && workflow.path === DESKTOP_PATH &&
    workflow.state === 'active', 'DESKTOP_WORKFLOW_MISMATCH')
}
function assertNoDesktopRuns(runs) {
  requireValue(runs?.total_count === 0 && Array.isArray(runs.workflow_runs) &&
    runs.workflow_runs.length === 0, 'DESKTOP_RUN_ALREADY_EXISTS')
}
export function validateSnapshot(snapshot, binding = BINDING) {
  assertBinding(binding)
  assertMain(snapshot.main, binding)
  assertIssue(snapshot.issue)
  assertWeb(snapshot.web, binding)
  assertWorkflow(snapshot.workflow, binding)
  assertNoDesktopRuns(snapshot.runs)
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

// Test-only dependency injection. CLI source/workflow/payload are fixed and
// cannot be selected by arguments or environment variables.
export async function requestDesktopDispatch({
  binding = BINDING, env = process.env, fetchImpl = fetch,
} = {}) {
  const report = {
    schemaVersion: 1, kind: 'normal-desktop-dispatch',
    applicationSha: BINDING.applicationSha, webRunId: BINDING.webRunId,
    desktopWorkflowId: BINDING.desktopWorkflowId,
    result: 'blocked', code: null, httpStatus: null,
    guardsPassed: false, postAttempted: false,
    dispatchedRunVerified: false, publishedVerified: false,
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
    const urls = [
      REPO_API + '/git/ref/heads/main', REPO_API + '/issues/1415',
      REPO_API + '/actions/runs/' + binding.webRunId, workflowUrl,
      workflowUrl + '/runs?head_sha=' + binding.applicationSha + '&branch=main&per_page=100',
    ]
    async function snapshot() {
      const values = await Promise.all(urls.map(url => get(url)))
      return Object.fromEntries(['main', 'issue', 'web', 'workflow', 'runs']
        .map((name, index) => [name, values[index]]))
    }
    validateSnapshot(await snapshot(), binding)
    // Repeat all mutable guards immediately before the only write. GitHub's
    // normal dispatch resolves ref=main; the eventual run SHA must still be read
    // from GitHub. A 204 is only acceptance, not proof of signing or publication.
    validateSnapshot(await snapshot(), binding)
    report.guardsPassed = true
    report.postAttempted = true
    let response
    try {
      response = await fetchImpl(workflowUrl + '/dispatches', {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(PAYLOAD),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      report.result = 'request_uncertain'
      throw new ClosedError('DISPATCH_TRANSPORT_UNCERTAIN')
    }
    report.httpStatus = response.status
    await cancelBody(response)
    requireValue(response.status === 204 && !response.redirected &&
      (!response.url || response.url === workflowUrl + '/dispatches'), 'DISPATCH_NOT_ACCEPTED')
    report.result = 'request_accepted'
    report.code = 'DISPATCH_ACCEPTED'
  } catch (error) {
    if (report.postAttempted && report.result !== 'request_uncertain') report.result = 'failed'
    report.code = error instanceof ClosedError ? error.code : 'INTERNAL_FAILURE'
    if (error instanceof ClosedError && error.status !== null) report.httpStatus = error.status
  }
  return report
}
async function main() {
  requireValue(process.argv.length === 2, 'ARGUMENTS_REJECTED')
  const report = await requestDesktopDispatch()
  await mkdir('desktop-dispatch-report', { recursive: true, mode: 0o700 })
  await writeFile('desktop-dispatch-report/result.json', JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({
    result: report.result, code: report.code, httpStatus: report.httpStatus,
    postAttempted: report.postAttempted, publishedVerified: false,
  }))
  if (report.result !== 'request_accepted') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ result: 'failed', code: 'CONTROLLER_FAILURE' }))
    process.exitCode = 1
  })
}
