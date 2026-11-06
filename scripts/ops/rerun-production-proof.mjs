import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const API = 'https://api.github.com'
const REPO_API = API + '/repos/' + REPOSITORY
const PUBLIC_VERSION = 'https://app.aspectlylabs.com/mikka/api/version'
const BRANCH = 'refs/heads/ops/issue1415-rerun-production-proof'

// Bind this one ID only after reading the actual 791 cancelled run.
// The unbound template refuses before any network request.
export const BINDING = Object.freeze({
  applicationSha: '79184a04366bfaf196248c339c9dcca42e0b16e9',
  webRunId: 42256819347,
  e2bRunId: 42256819385,
  targetRunId: 42260466754,
})

class ClosedError extends Error {
  constructor(code, status = null) {
    super(code)
    this.code = code
    this.status = Number.isInteger(status) ? status : null
  }
}
function requireValue(value, code) {
  if (!value) throw new ClosedError(code)
}
function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0
}
export function assertBinding(binding) {
  requireValue(binding?.applicationSha === BINDING.applicationSha &&
    binding?.webRunId === BINDING.webRunId && binding?.e2bRunId === BINDING.e2bRunId,
  'BINDING_MISMATCH')
  requireValue(positiveId(binding.targetRunId) &&
    ![binding.webRunId, binding.e2bRunId].includes(binding.targetRunId), 'TARGET_UNBOUND')
}
function assertContext(env) {
  requireValue(env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(OWNER_ID) &&
    env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === BRANCH &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    positiveId(Number(env.GITHUB_RUN_ID)), 'CONTROLLER_CONTEXT_REJECTED')
  requireValue(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'GITHUB_TOKEN_MISSING')
}
function sameRepository(repository) {
  return repository?.id === REPOSITORY_ID && repository?.full_name === REPOSITORY &&
    repository?.owner?.id === OWNER_ID
}
function assertRun(run, id, path, event, binding) {
  requireValue(run?.id === id && sameRepository(run.repository) &&
    sameRepository(run.head_repository) && run.head_branch === 'main' &&
    run.head_sha === binding.applicationSha && run.path === path && run.event === event,
  'RUN_IDENTITY_MISMATCH')
}
function assertMain(main, binding) {
  requireValue(main?.ref === 'refs/heads/main' && main?.object?.type === 'commit' &&
    main.object.sha === binding.applicationSha, 'MAIN_CHANGED')
}
function assertIssue(issue) {
  requireValue(issue?.number === 1415 && issue.state === 'open' &&
    issue.repository_url === REPO_API && !issue.pull_request, 'ISSUE_NOT_OPEN')
}
function assertTarget(target, jobs, binding) {
  assertRun(target, binding.targetRunId, '.github/workflows/read-cache-production.yml',
    'workflow_run', binding)
  requireValue(target.status === 'completed' && target.conclusion === 'cancelled' &&
    target.run_attempt === 1, 'TARGET_NOT_UNEXECUTED_CANCELLED')
  requireValue(jobs?.total_count === 0 && Array.isArray(jobs.jobs) && jobs.jobs.length === 0,
    'TARGET_HAS_JOBS')
}
function assertUpstream(run, id, path, binding) {
  assertRun(run, id, path, 'push', binding)
  requireValue(run.status === 'completed' && run.conclusion === 'success', 'UPSTREAM_NOT_SUCCESS')
}
function assertVersion(version, binding) {
  requireValue(version?.build === binding.applicationSha, 'PUBLIC_BUILD_MISMATCH')
}
export function validateSnapshot(snapshot, binding = BINDING) {
  assertBinding(binding)
  assertMain(snapshot.main, binding)
  assertIssue(snapshot.issue)
  assertTarget(snapshot.target, snapshot.jobs, binding)
  assertUpstream(snapshot.web, binding.webRunId, '.github/workflows/web-deploy.yml', binding)
  assertUpstream(snapshot.e2b, binding.e2bRunId, '.github/workflows/e2b-official-runtime.yml', binding)
  assertVersion(snapshot.version, binding)
}
async function cancelBody(response) {
  try { await response.body?.cancel() } catch { /* Response content is never retained. */ }
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
  } catch (error) {
    try { await reader.cancel() } catch { /* Preserve the original closed error. */ }
    if (error instanceof ClosedError) throw error
    throw new ClosedError('RESPONSE_JSON_INVALID')
  } finally {
    reader.releaseLock()
  }
}

// Only synthetic tests inject fetch/metadata. CLI bindings cannot be selected
// through environment variables or arguments.
export async function requestWholeRunRerun({
  binding = BINDING, env = process.env, fetchImpl = fetch,
} = {}) {
  const report = {
    schemaVersion: 1,
    applicationSha: binding?.applicationSha ?? null,
    targetRunId: binding?.targetRunId ?? null,
    webRunId: BINDING.webRunId,
    e2bRunId: BINDING.e2bRunId,
    result: 'blocked', code: null, httpStatus: null,
    guardsPassed: false, postAttempted: false, businessExecutionVerified: false,
  }
  try {
    assertBinding(binding)
    assertContext(env)
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
    }
    async function get(url, authenticated = true) {
      requireValue(new URL(url).origin === (authenticated ? API : new URL(PUBLIC_VERSION).origin),
        'REQUEST_ORIGIN_REJECTED')
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: authenticated ? headers : { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(15_000),
        })
      } catch { throw new ClosedError('READ_TRANSPORT_FAILED') }
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
        await cancelBody(response)
        throw new ClosedError('READ_RESPONSE_REJECTED', response.status)
      }
      return readJson(response, authenticated ? 131_072 : 8_192)
    }
    const runUrl = REPO_API + '/actions/runs/' + binding.targetRunId
    const urls = [
      REPO_API + '/git/ref/heads/main', REPO_API + '/issues/1415',
      runUrl, runUrl + '/jobs?per_page=100',
      REPO_API + '/actions/runs/' + binding.webRunId,
      REPO_API + '/actions/runs/' + binding.e2bRunId,
    ]
    const values = await Promise.all(urls.map(url => get(url)))
    const version = await get(PUBLIC_VERSION, false)
    const snapshot = Object.fromEntries(['main', 'issue', 'target', 'jobs', 'web', 'e2b']
      .map((name, index) => [name, values[index]]))
    validateSnapshot({ ...snapshot, version }, binding)

    // Recheck mutable gates immediately before the only write. This requests
    // the original run again; it does not forge a workflow event/check result.
    const fresh = await Promise.all([get(urls[0]), get(urls[1]), get(runUrl), get(urls[3])])
    assertMain(fresh[0], binding)
    assertIssue(fresh[1])
    assertTarget(fresh[2], fresh[3], binding)
    assertVersion(await get(PUBLIC_VERSION, false), binding)
    report.guardsPassed = true
    report.postAttempted = true
    let response
    try {
      response = await fetchImpl(runUrl + '/rerun', {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable_debug_logging: false }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      report.result = 'request_uncertain'
      throw new ClosedError('RERUN_TRANSPORT_UNCERTAIN')
    }
    report.httpStatus = response.status
    await cancelBody(response)
    requireValue(response.status === 201 && !response.redirected &&
      (!response.url || response.url === runUrl + '/rerun'), 'RERUN_NOT_ACCEPTED')
    report.result = 'request_accepted'
    report.code = 'RERUN_ACCEPTED'
  } catch (error) {
    if (report.postAttempted && report.result !== 'request_uncertain') report.result = 'failed'
    report.code = error instanceof ClosedError ? error.code : 'INTERNAL_FAILURE'
    if (error instanceof ClosedError && error.status !== null) report.httpStatus = error.status
  }
  return report
}
async function main() {
  requireValue(process.argv.length === 2, 'ARGUMENTS_REJECTED')
  const report = await requestWholeRunRerun()
  await mkdir('production-proof-rerun-report', { recursive: true, mode: 0o700 })
  await writeFile('production-proof-rerun-report/result.json',
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({
    result: report.result, code: report.code, httpStatus: report.httpStatus,
    postAttempted: report.postAttempted, businessExecutionVerified: false,
  }))
  if (report.result !== 'request_accepted') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ result: 'failed', code: 'CONTROLLER_FAILURE' }))
    process.exitCode = 1
  })
}
