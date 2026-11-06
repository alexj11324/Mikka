import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPO = 'alexj11324/Mikka', REPO_ID = 1427517699, OWNER_ID = 183887963
const BRANCH = 'ops/issue1415-production-database-targets'
const WORKFLOW = '.github/workflows/issue1415-production-database-targets.yml'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const GH = 'https://api.github.com/repos/' + REPO
const VERCEL = 'https://api.vercel.com'
const LIST = VERCEL + '/v10/projects/' + PROJECT + '/env?decrypt=false&teamId=' + TEAM
const KEYS = ['DATABASE_URL', 'MIKKA_DATABASE_URL']
const sameRepo = value => value?.id === REPO_ID && value.full_name === REPO && value.owner?.id === OWNER_ID
const production = value => value?.target === 'production' || Array.isArray(value?.target) && value.target.includes('production')
const noBranch = value => value.gitBranch === undefined || value.gitBranch === null || value.gitBranch === ''
class TargetError extends Error {
  constructor(code, { cause } = {}) { super(code, { cause }); this.code = code }
}
const check = (ok, code) => { if (!ok) throw new TargetError(code) }
const publicCode = error => error instanceof TargetError ? error.code : 'inspection_failed'
const blank = () => ({
  version: 1, kind: 'production-database-targets', status: 'failed', code: null,
  configurationScope: 'current-project-production-configuration', deploymentBindingVerified: false,
  businessExecutionVerified: false, ownerRequests: 0, sqlQueries: 0, mutations: 0,
  driverRevision: null, driverRunId: null, driverRunAttempt: null,
  metadataComplete: false, selectedVariableCount: 0, decryptedVariableCount: 0,
  targets: [],
})
function guard(env, event) {
  check(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REPOSITORY_ID === String(REPO_ID) &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(OWNER_ID) && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/' + BRANCH && env.GITHUB_RUN_ATTEMPT === '1' &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
    event?.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.deleted === false &&
    sameRepo(event.repository), 'context_rejected')
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0 &&
    typeof env.VERCEL_TEAM_TOKEN === 'string' && env.VERCEL_TEAM_TOKEN.length > 0, 'credentials_missing')
}
function target(value, metadata) {
  check(value?.key === metadata.key && (value.id === undefined || value.id === metadata.id) &&
    (value.target === undefined || production(value)) && noBranch(value) &&
    (value.updatedAt === undefined || metadata.updatedAt === undefined || value.updatedAt === metadata.updatedAt),
  'variable_identity_changed')
  check(typeof value.value === 'string' && value.value.length > 0, 'variable_value_unavailable')
  let parsed, database
  try { parsed = new URL(value.value); database = decodeURIComponent(parsed.pathname.slice(1)) }
  catch (cause) { throw new TargetError('database_url_invalid', { cause }) }
  const port = parsed.port ? Number(parsed.port) : 5432
  check(['postgres:', 'postgresql:'].includes(parsed.protocol) &&
    /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(parsed.hostname) &&
    /^[a-zA-Z0-9_.-]{1,63}$/.test(database) && !parsed.hash &&
    Number.isInteger(port) && port > 0 && port <= 65535, 'database_url_invalid')
  const updatedAt = value.updatedAt ?? metadata.updatedAt ?? null
  check(updatedAt === null || Number.isSafeInteger(updatedAt) && updatedAt >= 0, 'variable_metadata_invalid')
  return { key: metadata.key, host: parsed.hostname, port, database, updatedAt }
}

export async function inspectDatabaseTargets({ env = process.env, event, fetchImpl = fetch } = {}) {
  const report = blank(), allowed = new Map(), deadline = Date.now() + 120_000
  async function get(url) {
    const provider = allowed.get(url)
    check(provider === 'github' || provider === 'vercel', 'request_rejected')
    const remaining = deadline - Date.now()
    check(remaining > 0, 'inspection_deadline')
    const token = provider === 'github' ? env.GH_TOKEN : env.VERCEL_TEAM_TOKEN
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token,
          ...(provider === 'github' ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) },
        signal: AbortSignal.timeout(Math.min(20_000, remaining)),
      })
    } catch (cause) { throw new TargetError('http_transport_failed', { cause }) }
    check(!response.redirected && (!response.url || response.url === url), 'redirect_rejected')
    if (response.status !== 200) {
      try { await response.body?.cancel() } catch { /* Preserve the closed HTTP failure. */ }
      throw new TargetError('http_status_failed')
    }
    check(response.body, 'response_invalid')
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        check(size <= 4_194_304, 'response_too_large')
        chunks.push(Buffer.from(item.value))
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch (cause) { throw new TargetError('response_invalid', { cause }) }
    } finally {
      try { await reader.cancel() } catch { /* Only bounded response cleanup. */ }
      reader.releaseLock()
    }
  }
  try {
    guard(env, event)
    report.driverRevision = env.GITHUB_SHA
    report.driverRunId = Number(env.GITHUB_RUN_ID); report.driverRunAttempt = 1
    const runURL = GH + '/actions/runs/' + env.GITHUB_RUN_ID
    allowed.set(runURL, 'github'); allowed.set(GH + '/issues/1415', 'github')
    const run = await get(runURL)
    check(run?.id === report.driverRunId && run.event === 'push' && run.head_branch === BRANCH &&
      run.head_sha === env.GITHUB_SHA && run.run_attempt === 1 && run.path === WORKFLOW &&
      run.status === 'in_progress' && sameRepo(run.repository) && sameRepo(run.head_repository),
    'driver_context_mismatch')
    const issue = await get(GH + '/issues/1415')
    check(issue?.number === 1415 && issue.state === 'open' && issue.repository_url === GH && !issue.pull_request,
      'issue_not_open')
    allowed.set(LIST, 'vercel')
    const listing = await get(LIST)
    check(Array.isArray(listing?.envs) && listing.envs.length <= 5000 &&
      (listing.hiddenProductionEnvCount === undefined || listing.hiddenProductionEnvCount === 0) &&
      (listing.pagination?.next === undefined || listing.pagination.next === null), 'metadata_incomplete')
    report.metadataComplete = true
    const selected = KEYS.map(key => {
      const matches = listing.envs.filter(row => row?.key === key && production(row) && noBranch(row))
      check(matches.length === 1 && /^[a-zA-Z0-9_-]{1,160}$/.test(matches[0].id ?? ''), 'production_variable_not_unique')
      const { id, key: name, updatedAt } = matches[0]
      return { id, key: name, updatedAt }
    })
    check(new Set(selected.map(row => row.id)).size === KEYS.length, 'production_variable_not_unique')
    report.selectedVariableCount = selected.length
    for (const row of selected) {
      const url = VERCEL + '/v1/projects/' + PROJECT + '/env/' + row.id + '?teamId=' + TEAM
      allowed.set(url, 'vercel')
      const value = await get(url)
      report.decryptedVariableCount++
      report.targets.push(target(value, row))
    }
    report.status = 'inspected'; report.code = 'inspection_completed'
  } catch (error) { report.code = publicCode(error) }
  return report
}
async function main() {
  let report
  try {
    check(process.argv.length === 2, 'arguments_rejected')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = await inspectDatabaseTargets({ event })
  } catch (error) { report = { ...blank(), code: publicCode(error) } }
  await mkdir('production-database-targets-report', { recursive: true, mode: 0o700 })
  await writeFile('production-database-targets-report/report.json', JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
  if (report.status !== 'inspected') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('production_database_target_output_failed'); process.exitCode = 1 })
}
