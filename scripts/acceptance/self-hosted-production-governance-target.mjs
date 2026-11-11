// One registered Organization owner/audit continuation. It has no Core
// business selection and does not borrow the Inbox issue or its attestation.
import { createHash } from 'node:crypto'
import { CORE_ORIGIN, CORE_WORKFLOW, CoreProductionError, coreProductionGuard } from './self-hosted-production-target.mjs'
import { successfulRelease } from './project-decisions.mjs'
import { governanceRecoveryReference } from './self-hosted-production-governance-recovery.mjs'

export const GOVERNANCE_ISSUE = 1608
export const GOVERNANCE_PR = 1856
export const GOVERNANCE_BRANCH = 'fix/backend-production-followup-1608-1820'
export const GOVERNANCE_ORIGIN_PR = 1831
export const GOVERNANCE_ORIGIN_BRANCH = 'batch/2026-11-09-1608-governance'
export const GOVERNANCE_ORIGIN_MERGE = '08327db0f3e7b78fc296f82232ecf0afda6ecd5b'
export const GOVERNANCE_ORIGIN_HEAD = '738f8d68ad2bfe77f180c6f52c27e881bd4674bd'
const PURPOSE = 'governance-1608-followup-selection'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const MARKER = '<!-- mikka-governance-followup-1856 '
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value))
const digest = value => createHash('sha256').update(value).digest('hex')
const codes = new Set(['governance_configuration', 'governance_selection_invalid', 'governance_read_failed',
  'governance_target_changed', 'governance_window_invalid', 'governance_selection_changed'])
const details = new Set(['mode', 'repository', 'workflow', 'event', 'identity', 'token', 'driver', 'issue',
  'main', 'version', 'web', 'jobs', 'steps', 'target', 'window', 'comment', 'marker', 'time', 'recovery', 'transport', 'response'])

export class GovernanceSelectionError extends Error {
  constructor(code, detail, { cause, httpStatus } = {}) {
    super(codes.has(code) ? code : 'governance_selection_invalid', { cause })
    this.name = 'GovernanceSelectionError'; this.code = this.message
    this.detail = details.has(detail) ? detail : 'response'
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus
  }
}
const check = (value, detail, code = 'governance_selection_invalid') => {
  if (!value) throw new GovernanceSelectionError(code, detail)
}
export const governanceSelectionFailure = error => error instanceof GovernanceSelectionError
  ? { code: codes.has(error.code) ? error.code : 'governance_selection_invalid',
    detail: details.has(error.detail) ? error.detail : 'response',
    ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) }
  : error instanceof CoreProductionError ? { code: 'governance_configuration', detail: details.has(error.detail) ? error.detail : 'response' }
    : { code: 'governance_selection_invalid', detail: 'response' }

export function governanceWindowProof(comment, { headSha, sourceSha, now = Date.now(), expected } = {}) {
  check(positive(comment?.id) && comment.user?.login === 'alexj11324' && typeof comment.body === 'string'
    && comment.body.length <= 65_536 && (!expected || comment.id === expected.commentId), 'comment', 'governance_window_invalid')
  const matches = [...comment.body.matchAll(/<!-- mikka-governance-followup-1856 (\{[^\r\n]*\}) -->/g)]
  check(matches.length === 1 && comment.body.split(MARKER).length === 2, 'marker', 'governance_window_invalid')
  let marker
  try { marker = JSON.parse(matches[0][1]) }
  catch (cause) { throw new GovernanceSelectionError('governance_window_invalid', 'marker', { cause }) }
  const allowed = new Set(['schema', 'state', 'issue', 'pr', 'branch', 'headSha', 'sourceSha', 'originPr',
    'originMergeSha', 'originHeadSha', 'startsAt', 'expiresAt', 'phase', 'recovery'])
  check(object(marker) && Object.keys(marker).every(key => allowed.has(key)) && marker.schema === 1
    && marker.state === 'active' && marker.issue === GOVERNANCE_ISSUE && marker.pr === GOVERNANCE_PR
    && marker.branch === GOVERNANCE_BRANCH && SHA.test(headSha ?? '') && marker.headSha === headSha
    && SHA.test(sourceSha ?? '') && marker.sourceSha === sourceSha && marker.originPr === GOVERNANCE_ORIGIN_PR
    && marker.originMergeSha === GOVERNANCE_ORIGIN_MERGE && marker.originHeadSha === GOVERNANCE_ORIGIN_HEAD,
  'marker', 'governance_window_invalid')
  const starts = Date.parse(marker.startsAt), expires = Date.parse(marker.expiresAt)
  check(iso(marker.startsAt) && iso(marker.expiresAt) && Number.isFinite(now) && starts <= now && expires > now
    && expires > starts && expires - starts <= 120 * 60_000, 'time', 'governance_window_invalid')
  check(['owner-audit', 'cleanup'].includes(marker.phase) && (marker.phase === 'cleanup' || marker.recovery === undefined),
    'marker', 'governance_window_invalid')
  let recovery = null
  if (marker.phase === 'cleanup') {
    try { recovery = governanceRecoveryReference(marker.recovery) }
    catch (cause) { throw new GovernanceSelectionError('governance_window_invalid', 'recovery', { cause }) }
  }
  const markerSha256 = digest(matches[0][0])
  check(!expected || expected.markerSha256 === markerSha256 && expected.headSha === headSha
    && expected.sourceSha === sourceSha && expected.phase === marker.phase, 'marker', 'governance_window_invalid')
  return { commentId: comment.id, markerSha256, pr: GOVERNANCE_PR, branch: GOVERNANCE_BRANCH,
    headSha, sourceSha, originPr: GOVERNANCE_ORIGIN_PR, originMergeSha: GOVERNANCE_ORIGIN_MERGE,
    originHeadSha: GOVERNANCE_ORIGIN_HEAD, startsAt: marker.startsAt, expiresAt: marker.expiresAt,
    phase: marker.phase, recovery }
}

async function readWindow(read, { headSha, sourceSha, now, expected }) {
  const issue = await read('/issues/1752')
  check(issue?.number === 1752 && issue.url === API + '/issues/1752' && issue.repository_url === API
    && issue.pull_request?.url === API + '/pulls/1752' && positive(issue.comments), 'window', 'governance_window_invalid')
  const lastPage = Math.ceil(issue.comments / 100)
  const pages = await Promise.all([...new Set([Math.max(1, lastPage - 1), lastPage])]
    .map(page => read(`/issues/1752/comments?per_page=100&page=${page}`)))
  check(pages.every(page => Array.isArray(page) && page.length <= 100), 'window', 'governance_window_invalid')
  const latest = pages.flat().filter(comment => comment?.user?.login === 'alexj11324' && positive(comment.id)
    && typeof comment.body === 'string' && comment.body.includes(MARKER)).sort((a, b) => a.id - b.id).at(-1)
  check(latest && (!expected || latest.id === expected.commentId), 'window', 'governance_window_invalid')
  const comment = await read('/issues/comments/' + latest.id)
  check(comment?.id === latest.id, 'comment', 'governance_window_invalid')
  return governanceWindowProof(comment, { headSha, sourceSha, expected, now: now() })
}

const ordinary = (commit, sourceSha, headSha) => commit?.sha === sourceSha && Array.isArray(commit.parents)
  && commit.parents.length === 2 && commit.parents.every(parent => SHA.test(parent?.sha ?? ''))
  && commit.parents[0].sha !== commit.parents[1].sha && commit.parents[1].sha === headSha

/** Read-only, fixed-purpose selection. Calling again with the original result
 * is the lease immediately before a write: no changed source/window may fall
 * through to another phase or turn an in-flight run into not_selected. */
export async function selectGovernanceProduction({ env = process.env, event, fetchImpl = fetch,
  now = Date.now, expectedSelection } = {}) {
  let guard
  try { guard = coreProductionGuard(env, event) }
  catch (cause) { throw new GovernanceSelectionError('governance_configuration', cause instanceof CoreProductionError ? cause.detail : 'identity', { cause }) }
  const hasExpected = expectedSelection !== undefined
  const empty = reason => ({ schema: 1, purpose: PURPOSE, selected: false, status: 'not_selected', reason,
    issue: GOVERNANCE_ISSUE, pr: GOVERNANCE_PR, branch: GOVERNANCE_BRANCH, originPr: GOVERNANCE_ORIGIN_PR,
    originMergeSha: GOVERNANCE_ORIGIN_MERGE, originHeadSha: GOVERNANCE_ORIGIN_HEAD, ...guard,
    checkedAt: new Date(now()).toISOString() })
  const decline = reason => {
    check(!hasExpected, 'target', 'governance_selection_changed')
    return empty(reason)
  }
  if (hasExpected) check(object(expectedSelection) && expectedSelection.schema === 1 && expectedSelection.purpose === PURPOSE
    && expectedSelection.selected === true && expectedSelection.status === 'selected' && expectedSelection.issue === GOVERNANCE_ISSUE
    && expectedSelection.pr === GOVERNANCE_PR && expectedSelection.branch === GOVERNANCE_BRANCH
    && expectedSelection.originPr === GOVERNANCE_ORIGIN_PR && expectedSelection.originMergeSha === GOVERNANCE_ORIGIN_MERGE
    && expectedSelection.originHeadSha === GOVERNANCE_ORIGIN_HEAD && SHA.test(expectedSelection.headSha ?? '')
    && Object.entries(guard).every(([key, value]) => expectedSelection[key] === value)
    && positive(expectedSelection.webAttempt) && positive(expectedSelection.webDeployJobId)
    && iso(expectedSelection.checkedAt) && Date.parse(expectedSelection.checkedAt) <= now()
    && positive(expectedSelection.window?.commentId) && HASH.test(expectedSelection.window?.markerSha256 ?? ''),
  'target', 'governance_selection_changed')
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'token', 'governance_configuration')
  const read = async (path, github = true) => {
    const url = (github ? API : CORE_ORIGIN) + path
    let response, value
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', 'cache-control': 'no-store', ...(github ? {
        authorization: 'Bearer ' + env.GH_TOKEN, 'x-github-api-version': '2022-11-28',
      } : {}) } }) }
    catch (cause) { throw new GovernanceSelectionError('governance_read_failed', 'transport', { cause }) }
    if (!response.ok || response.redirected || response.url && response.url !== url)
      throw new GovernanceSelectionError('governance_read_failed', 'response', { httpStatus: response.status })
    try { value = await response.json() }
    catch (cause) { throw new GovernanceSelectionError('governance_read_failed', 'response', { cause, httpStatus: response.status }) }
    return value
  }
  const pr = await read('/pulls/' + GOVERNANCE_PR)
  if (pr?.number !== GOVERNANCE_PR || pr.user?.login !== 'alexj11324' || pr.base?.repo?.full_name !== REPOSITORY
    || pr.base.ref !== 'main' || pr.head?.repo?.full_name !== REPOSITORY || pr.head.ref !== GOVERNANCE_BRANCH
    || !SHA.test(pr.head.sha ?? '')) return decline('not_registered_followup')
  if (pr.merged !== true || pr.merge_commit_sha !== guard.applicationSha) return decline('not_followup_merge')
  if (hasExpected) check(pr.head.sha === expectedSelection.headSha, 'target', 'governance_selection_changed')
  const commit = await read('/git/commits/' + guard.applicationSha)
  if (!ordinary(commit, guard.applicationSha, pr.head.sha)) return decline('not_ordinary_followup_merge')
  const original = await read('/pulls/' + GOVERNANCE_ORIGIN_PR)
  if (original?.number !== GOVERNANCE_ORIGIN_PR || original.merged !== true || original.merge_commit_sha !== GOVERNANCE_ORIGIN_MERGE
    || original.base?.repo?.full_name !== REPOSITORY || original.base.ref !== 'main' || original.head?.repo?.full_name !== REPOSITORY
    || original.head.ref !== GOVERNANCE_ORIGIN_BRANCH || original.head.sha !== GOVERNANCE_ORIGIN_HEAD) return decline('not_original_team_merge')
  if (!ordinary(await read('/git/commits/' + GOVERNANCE_ORIGIN_MERGE), GOVERNANCE_ORIGIN_MERGE, GOVERNANCE_ORIGIN_HEAD))
    return decline('not_original_ordinary_merge')
  let cursor = commit.parents[0].sha, firstParentDepth = 0
  const seen = new Set()
  while (cursor !== GOVERNANCE_ORIGIN_MERGE && firstParentDepth < 64) {
    if (seen.has(cursor)) return decline('original_not_on_first_parent_chain')
    seen.add(cursor)
    const parent = await read('/git/commits/' + cursor)
    if (parent?.sha !== cursor || !Array.isArray(parent.parents) || ![1, 2].includes(parent.parents.length)
      || !parent.parents.every(row => SHA.test(row?.sha ?? ''))) return decline('original_not_on_first_parent_chain')
    cursor = parent.parents[0].sha; firstParentDepth++
  }
  if (cursor !== GOVERNANCE_ORIGIN_MERGE) return decline('original_not_on_first_parent_chain')
  const issue = await read('/issues/' + GOVERNANCE_ISSUE)
  check(issue?.number === GOVERNANCE_ISSUE && issue.url === API + '/issues/' + GOVERNANCE_ISSUE
    && issue.repository_url === API && !issue.pull_request && ['open', 'closed'].includes(issue.state), 'issue')
  if (issue.state !== 'open') return decline('governance_issue_closed')
  const driver = await read('/actions/runs/' + guard.driverRunId)
  check(driver?.id === guard.driverRunId && driver.run_attempt === guard.driverRunAttempt
    && driver.repository?.full_name === REPOSITORY && driver.head_repository?.full_name === REPOSITORY
    && driver.url === API + '/actions/runs/' + guard.driverRunId && driver.path === CORE_WORKFLOW
    && driver.event === 'workflow_run' && driver.head_branch === 'main' && driver.head_sha === guard.driverRevision
    && driver.status === 'in_progress' && driver.conclusion === null, 'driver')
  const pin = async () => {
    const main = await read('/git/ref/heads/main')
    check(main?.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === guard.applicationSha,
      'main', 'governance_target_changed')
    check((await read('/mikka/api/version', false))?.build === guard.applicationSha, 'version', 'governance_target_changed')
  }
  let release, job, window
  try {
    await pin()
    release = await read('/actions/runs/' + guard.webDeployRunId)
    check(release?.id === guard.webDeployRunId && positive(release.run_attempt)
      && release.repository?.full_name === REPOSITORY && release.head_repository?.full_name === REPOSITORY
      && release.url === API + '/actions/runs/' + guard.webDeployRunId && release.event === 'push'
      && successfulRelease([release], guard.applicationSha, 'web') !== null, 'web')
    const listing = await read(`/actions/runs/${release.id}/attempts/${release.run_attempt}/jobs?per_page=100`)
    check(positive(listing?.total_count) && listing.total_count <= 100 && Array.isArray(listing.jobs)
      && listing.total_count === listing.jobs.length, 'jobs')
    const candidates = listing.jobs.filter(row => row?.name === 'deploy')
    job = candidates[0]
    check(candidates.length === 1 && positive(job.id) && job.run_id === release.id && job.run_attempt === release.run_attempt
      && job.run_url === API + '/actions/runs/' + release.id && job.head_sha === guard.applicationSha && job.head_branch === 'main'
      && job.status === 'completed' && job.conclusion === 'success', 'jobs')
    check(Array.isArray(job.steps) && ['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
      'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
      .every(name => {
        const matches = job.steps.filter(step => step?.name === name)
        return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success'
      }), 'steps')
    check(!hasExpected || release.run_attempt === expectedSelection.webAttempt && job.id === expectedSelection.webDeployJobId,
      'web', 'governance_target_changed')
    window = await readWindow(read, { headSha: pr.head.sha, sourceSha: guard.applicationSha, now, expected: expectedSelection?.window })
    await pin()
    check(Date.parse(window.expiresAt) > now(), 'time', 'governance_window_invalid')
    if (window.phase === 'cleanup') check(window.recovery.runId === guard.driverRunId && window.recovery.attempt < guard.driverRunAttempt,
      'recovery', 'governance_window_invalid')
  } catch (error) {
    if (!hasExpected && error instanceof GovernanceSelectionError) {
      if (error.code === 'governance_window_invalid') return empty('window_not_active')
      if (error.code === 'governance_target_changed' && ['main', 'version'].includes(error.detail))
        return empty(error.detail === 'main' ? 'main_moved' : 'deployment_changed')
    }
    throw error
  }
  return { ...empty('registered_team_followup_and_active_window'), selected: true, status: 'selected',
    headSha: pr.head.sha, firstParentDepth, webAttempt: release.run_attempt, webDeployJobId: job.id, window }
}
