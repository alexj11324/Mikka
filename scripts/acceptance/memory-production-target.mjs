// #1821 runs only for its own ordinary merge and active #1752 release window.
// This read-only selection runs before the existing Infisical account step.
import { createHash } from 'node:crypto'
import { coreProductionGuard, attestCoreProduction, assertCoreProductionTarget, CoreProductionError } from './self-hosted-production-target.mjs'
import { memoryNotificationDeclaration, verifyMemoryNotification } from './memory-production-pending.mjs'
import { readPriorMemoryCases } from './memory-production-cases.mjs'

export const MEMORY_PR = 1830
export const MEMORY_BRANCH = 'feat/1821-memory-provenance-scope'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const digest = value => createHash('sha256').update(value).digest('hex')
const codes = new Set(['memory_selection_read_failed', 'memory_selection_invalid', 'memory_window_invalid', 'memory_selection_changed'])
const details = new Set(['token', 'transport', 'response', 'pull_request', 'merge', 'window', 'comment', 'marker', 'time', 'target'])
export class MemorySelectionError extends Error {
  constructor(code, detail, options) {
    super(codes.has(code) ? code : 'memory_selection_invalid', options)
    this.name = 'MemorySelectionError'; this.code = this.message
    this.detail = details.has(detail) ? detail : 'response'
  }
}
const check = (value, code, detail) => { if (!value) throw new MemorySelectionError(code, detail) }
export const memorySelectionFailure = error => error instanceof MemorySelectionError
  ? { code: error.code, detail: error.detail } : null

/** The marker is in the owner's ordinary #1752 window comment. The source
 * field is filled with the actual merge before Web completion can select it.
 * A new own marker, any edit of this marker, expiry or another head revokes it. */
export function memoryWindowProof(comment, { headSha, sourceSha, now = Date.now(), expected } = {}) {
  check(positive(comment?.id) && comment.user?.login === 'alexj11324'
    && typeof comment.body === 'string' && comment.body.length <= 65_536
    && (!expected || comment.id === expected.commentId), 'memory_window_invalid', 'comment')
  const matches = [...comment.body.matchAll(/<!-- mikka-memory-1821 (\{[^\r\n]*\}) -->/g)]
  check(matches.length === 1, 'memory_window_invalid', 'marker')
  let marker
  try { marker = JSON.parse(matches[0][1]) }
  catch (cause) { throw new MemorySelectionError('memory_window_invalid', 'marker', { cause }) }
  const starts = Date.parse(marker.startsAt), expires = Date.parse(marker.expiresAt)
  const notification = memoryNotificationDeclaration(marker)
  check(marker.state === 'active' && marker.issue === 1821 && marker.pr === MEMORY_PR && marker.branch === MEMORY_BRANCH
    && SHA.test(headSha ?? '') && marker.headSha === headSha && SHA.test(sourceSha ?? '') && marker.sourceSha === sourceSha,
  'memory_window_invalid', 'marker')
  check(Number.isFinite(starts) && Number.isFinite(expires) && starts <= now && expires > now
    && expires - starts > 0 && expires - starts <= 120 * 60_000, 'memory_window_invalid', 'time')
  const markerSha256 = digest(matches[0][0])
  check(!expected || expected.markerSha256 === markerSha256 && expected.headSha === headSha && expected.sourceSha === sourceSha,
    'memory_window_invalid', 'marker')
  return { commentId: comment.id, branch: MEMORY_BRANCH, headSha, sourceSha,
    startsAt: marker.startsAt, expiresAt: marker.expiresAt, markerSha256,
    phase: marker.phase, fixtureNonce: marker.fixtureNonce,
    ...(notification ? { notification: marker.notification } : {}) }
}

export async function readMemoryWindow(read, { headSha, sourceSha, now = Date.now, expected } = {}) {
  const issue = await read('/issues/1752')
  check(Number.isSafeInteger(issue?.comments) && issue.comments > 0, 'memory_window_invalid', 'window')
  const lastPage = Math.ceil(issue.comments / 100)
  const pages = await Promise.all([...new Set([Math.max(1, lastPage - 1), lastPage])]
    .map(page => read(`/issues/1752/comments?per_page=100&page=${page}`)))
  check(pages.every(page => Array.isArray(page) && page.length <= 100), 'memory_window_invalid', 'window')
  // Discussion is not a release. Only this named marker grants or revokes this
  // driver's authority; no prose, attached evidence or workflow log is parsed.
  const markers = pages.flat().filter(comment => comment?.user?.login === 'alexj11324'
    && positive(comment.id) && typeof comment.body === 'string' && comment.body.includes('<!-- mikka-memory-1821 '))
    .sort((a, b) => a.id - b.id)
  const latest = markers.at(-1)
  check(latest && (!expected || latest.id === expected.commentId), 'memory_window_invalid', 'window')
  const comment = await read('/issues/comments/' + latest.id)
  // The clock is read after network completion, including an exact readback of
  // the selected comment, so a slow read cannot cross the expiry boundary.
  return memoryWindowProof(comment, { headSha, sourceSha, expected, now: now() })
}

export async function selectMemoryProduction({ env = process.env, event, attestation, fetchImpl = fetch,
  now = Date.now, expectedSelection, assertTarget = assertCoreProductionTarget } = {}) {
  const guard = coreProductionGuard(env, event)
  const empty = reason => ({ schema: 1, purpose: 'memory-1821-production-selection', selected: false,
    status: 'not_selected', reason, issue: 1821, pr: MEMORY_PR, applicationSha: guard.applicationSha,
    driverRunId: guard.driverRunId, driverRunAttempt: guard.driverRunAttempt, checkedAt: new Date(now()).toISOString() })
  const decline = reason => {
    check(!expectedSelection, 'memory_selection_changed', 'target')
    return empty(reason)
  }
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'memory_selection_invalid', 'token')
  const read = async path => {
    let response, value
    const url = API + path
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN,
          'x-github-api-version': '2022-11-28' } })
    } catch (cause) { throw new MemorySelectionError('memory_selection_read_failed', 'transport', { cause }) }
    check(response.ok && !response.redirected && (!response.url || response.url === url), 'memory_selection_read_failed', 'response')
    try { value = await response.json() }
    catch (cause) { throw new MemorySelectionError('memory_selection_read_failed', 'response', { cause }) }
    return value
  }
  const pr = await read('/pulls/' + MEMORY_PR)
  if (pr?.number !== MEMORY_PR || pr.base?.repo?.full_name !== REPOSITORY || pr.base.ref !== 'main'
    || pr.head?.repo?.full_name !== REPOSITORY || pr.head.ref !== MEMORY_BRANCH || !SHA.test(pr.head.sha ?? ''))
    return decline('not_pr_1830')
  if (pr.merged !== true || pr.merge_commit_sha !== guard.applicationSha) return decline('not_pr_1830_merge')
  const commit = await read('/git/commits/' + guard.applicationSha)
  if (commit?.sha !== guard.applicationSha || !Array.isArray(commit.parents) || commit.parents.length !== 2
    || !commit.parents.every(parent => SHA.test(parent.sha ?? '')) || commit.parents[1].sha !== pr.head.sha)
    return decline('not_ordinary_pr_merge')
  if (attestation?.status === 'skipped') return decline('memory_issue_closed')
  let target
  try { target = attestation ? await assertTarget({ env, event, attestation, fetchImpl, now })
    : await attestCoreProduction({ env, event, fetchImpl, now }) }
  catch (error) {
    if (!expectedSelection && error instanceof CoreProductionError && error.code === 'core_target_changed')
      return empty(error.detail === 'main' ? 'main_moved' : 'deployment_changed')
    throw error
  }
  if (target?.status !== 'ready' || !target.openIssues?.includes(1821)) return decline('memory_issue_closed')
  check(target.applicationSha === guard.applicationSha && (!expectedSelection
    || expectedSelection.purpose === 'memory-1821-production-selection' && expectedSelection.selected === true
      && expectedSelection.applicationSha === guard.applicationSha && positive(expectedSelection.window?.commentId)
      && /^[a-f0-9]{64}$/.test(expectedSelection.window.markerSha256 ?? '')
      && expectedSelection.headSha === pr.head.sha && expectedSelection.driverRunId === guard.driverRunId
      && expectedSelection.driverRunAttempt === guard.driverRunAttempt), 'memory_selection_changed', 'target')
  let window
  try { window = await readMemoryWindow(read, { headSha: pr.head.sha, sourceSha: guard.applicationSha,
    now, expected: expectedSelection?.window }) }
  catch (error) {
    if (!expectedSelection && error instanceof MemorySelectionError && error.code === 'memory_window_invalid') return empty('window_not_active')
    throw error
  }
  check(Date.parse(window.expiresAt) > now(), 'memory_window_invalid', 'time')
  const notification = await verifyMemoryNotification(window, { env, fetchImpl, now })
  const cases = await readPriorMemoryCases(read, { sourceSha: guard.applicationSha, runId: guard.driverRunId, runAttempt: guard.driverRunAttempt })
  check(Date.parse(window.expiresAt) > now(), 'memory_window_invalid', 'time')
  return { ...empty('exact_pr_merge_and_active_window'), selected: true, status: 'selected', headSha: pr.head.sha,
    window, notification, cases, attestation: target }
}
