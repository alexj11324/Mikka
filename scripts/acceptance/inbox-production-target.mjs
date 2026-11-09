// #1820 runs only for its own ordinary merge and active #1752 release window.
// This read-only selection runs before the existing Infisical account step.
import { createHash } from 'node:crypto'
import { coreProductionGuard, attestCoreProduction, assertCoreProductionTarget, CoreProductionError } from './self-hosted-production-target.mjs'
import { inboxRecoveryReference } from './inbox-production-recovery.mjs'

export const INBOX_PR = 1822
export const INBOX_BRANCH = 'feat/inbox-1820'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const positive = value => Number.isSafeInteger(value) && value > 0
const digest = value => createHash('sha256').update(value).digest('hex')
const codes = new Set(['inbox_selection_read_failed', 'inbox_selection_invalid', 'inbox_window_invalid', 'inbox_selection_changed'])
const details = new Set(['token', 'transport', 'response', 'pull_request', 'merge', 'window', 'comment', 'marker', 'time', 'target'])
export class InboxSelectionError extends Error {
  constructor(code, detail, options) {
    super(codes.has(code) ? code : 'inbox_selection_invalid', options)
    this.name = 'InboxSelectionError'; this.code = this.message
    this.detail = details.has(detail) ? detail : 'response'
  }
}
const check = (value, code, detail) => { if (!value) throw new InboxSelectionError(code, detail) }
export const inboxSelectionFailure = error => error instanceof InboxSelectionError
  ? { code: error.code, detail: error.detail } : null

// Only these public fixture identifiers can leave the window comment. An
// unknown field or provider response is never copied into an acceptance log.
function fixtureMetadata(value) {
  const github = value?.github
  check(value?.schema === 1 && value.purpose === 'mikka1820-owner-github-fixture'
    && UUID.test(value.nonce ?? '') && /^[a-f0-9]{64}$/.test(value.ownerHash ?? '') && UUID.test(value.workspaceId ?? '')
    && SHA.test(value.applicationSha ?? '') && positive(value.inventoryRunId) && positive(value.inventoryRunAttempt)
    && typeof value.createdAt === 'string' && value.createdAt.length <= 35 && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.expiresAt === 'string' && value.expiresAt.length <= 35 && Number.isFinite(Date.parse(value.expiresAt))
    && github?.repository === 'alexj11324/Mikka-handoff' && positive(github.issueNumber) && positive(github.eventId)
    && ['assigned', 'issue_comment'].includes(github.kind) && /^[1-9]\d{0,15}$/.test(github.recipientId ?? '')
    && /^[1-9]\d{0,15}$/.test(github.actorId ?? ''), 'inbox_window_invalid', 'marker')
  return { schema: 1, purpose: value.purpose, nonce: value.nonce, ownerHash: value.ownerHash, workspaceId: value.workspaceId,
    applicationSha: value.applicationSha, inventoryRunId: value.inventoryRunId, inventoryRunAttempt: value.inventoryRunAttempt,
    createdAt: value.createdAt, expiresAt: value.expiresAt, github: { repository: github.repository,
      issueNumber: github.issueNumber, eventId: github.eventId, kind: github.kind, recipientId: github.recipientId, actorId: github.actorId } }
}

/** The marker is in the owner's ordinary #1752 window comment. The source
 * field is filled with the actual merge before Web completion can select it.
 * A new own marker, any edit of this marker, expiry or another head revokes it. */
export function inboxWindowProof(comment, { headSha, sourceSha, now = Date.now(), expected } = {}) {
  check(positive(comment?.id) && comment.user?.login === 'alexj11324'
    && typeof comment.body === 'string' && comment.body.length <= 65_536
    && (!expected || comment.id === expected.commentId), 'inbox_window_invalid', 'comment')
  const matches = [...comment.body.matchAll(/<!-- mikka-inbox-1820 (\{[^\r\n]*\}) -->/g)]
  check(matches.length === 1, 'inbox_window_invalid', 'marker')
  let marker
  try { marker = JSON.parse(matches[0][1]) }
  catch (cause) { throw new InboxSelectionError('inbox_window_invalid', 'marker', { cause }) }
  const starts = Date.parse(marker.startsAt), expires = Date.parse(marker.expiresAt)
  check(marker.state === 'active' && marker.issue === 1820 && marker.pr === INBOX_PR && marker.branch === INBOX_BRANCH
    && SHA.test(headSha ?? '') && marker.headSha === headSha && SHA.test(sourceSha ?? '') && marker.sourceSha === sourceSha,
  'inbox_window_invalid', 'marker')
  check(Number.isFinite(starts) && Number.isFinite(expires) && starts <= now && expires > now
    && expires - starts > 0 && expires - starts <= 120 * 60_000, 'inbox_window_invalid', 'time')
  const phase = marker.phase ?? 'inventory'
  check(['inventory', 'fixture', 'cleanup'].includes(phase) && (phase === 'fixture' || marker.fixture === undefined)
    && (phase === 'cleanup' || marker.recovery === undefined), 'inbox_window_invalid', 'marker')
  const fixture = phase === 'fixture' ? fixtureMetadata(marker.fixture) : null
  let recovery = null
  if (phase === 'cleanup') {
    try { recovery = inboxRecoveryReference(marker.recovery) }
    catch { throw new InboxSelectionError('inbox_window_invalid', 'marker') }
  }
  check(!fixture || fixture.applicationSha === sourceSha, 'inbox_window_invalid', 'marker')
  const markerSha256 = digest(matches[0][0])
  check(!expected || expected.markerSha256 === markerSha256 && expected.headSha === headSha && expected.sourceSha === sourceSha,
    'inbox_window_invalid', 'marker')
  return { commentId: comment.id, branch: INBOX_BRANCH, headSha, sourceSha,
    startsAt: marker.startsAt, expiresAt: marker.expiresAt, markerSha256, phase, fixture, recovery }
}

export async function readInboxWindow(read, { headSha, sourceSha, now = Date.now, expected } = {}) {
  const issue = await read('/issues/1752')
  check(Number.isSafeInteger(issue?.comments) && issue.comments > 0, 'inbox_window_invalid', 'window')
  const lastPage = Math.ceil(issue.comments / 100)
  const pages = await Promise.all([...new Set([Math.max(1, lastPage - 1), lastPage])]
    .map(page => read(`/issues/1752/comments?per_page=100&page=${page}`)))
  check(pages.every(page => Array.isArray(page) && page.length <= 100), 'inbox_window_invalid', 'window')
  // Discussion is not a release. Only this named marker grants or revokes this
  // driver's authority; no prose, attached evidence or workflow log is parsed.
  const markers = pages.flat().filter(comment => comment?.user?.login === 'alexj11324'
    && positive(comment.id) && typeof comment.body === 'string' && comment.body.includes('<!-- mikka-inbox-1820 '))
    .sort((a, b) => a.id - b.id)
  const latest = markers.at(-1)
  check(latest && (!expected || latest.id === expected.commentId), 'inbox_window_invalid', 'window')
  const comment = await read('/issues/comments/' + latest.id)
  check(comment?.id === latest.id, 'inbox_window_invalid', 'comment')
  // The clock is read after network completion, including an exact readback of
  // the selected comment, so a slow read cannot cross the expiry boundary.
  return inboxWindowProof(comment, { headSha, sourceSha, expected, now: now() })
}

export async function selectInboxProduction({ env = process.env, event, attestation, fetchImpl = fetch,
  now = Date.now, expectedSelection, assertTarget = assertCoreProductionTarget } = {}) {
  const guard = coreProductionGuard(env, event)
  const empty = reason => ({ schema: 1, purpose: 'inbox-1820-production-selection', selected: false,
    status: 'not_selected', reason, issue: 1820, pr: INBOX_PR, applicationSha: guard.applicationSha,
    driverRunId: guard.driverRunId, driverRunAttempt: guard.driverRunAttempt, checkedAt: new Date(now()).toISOString() })
  const decline = reason => {
    check(!expectedSelection, 'inbox_selection_changed', 'target')
    return empty(reason)
  }
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'inbox_selection_invalid', 'token')
  const read = async path => {
    let response, value
    const url = API + path
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN,
          'x-github-api-version': '2022-11-28' } })
    } catch (cause) { throw new InboxSelectionError('inbox_selection_read_failed', 'transport', { cause }) }
    check(response.ok && !response.redirected && (!response.url || response.url === url), 'inbox_selection_read_failed', 'response')
    try { value = await response.json() }
    catch (cause) { throw new InboxSelectionError('inbox_selection_read_failed', 'response', { cause }) }
    return value
  }
  const pr = await read('/pulls/' + INBOX_PR)
  if (pr?.number !== INBOX_PR || pr.base?.repo?.full_name !== REPOSITORY || pr.base.ref !== 'main'
    || pr.head?.repo?.full_name !== REPOSITORY || pr.head.ref !== INBOX_BRANCH || !SHA.test(pr.head.sha ?? ''))
    return decline('not_pr_1822')
  if (pr.merged !== true || pr.merge_commit_sha !== guard.applicationSha) return decline('not_pr_1822_merge')
  const commit = await read('/git/commits/' + guard.applicationSha)
  if (commit?.sha !== guard.applicationSha || !Array.isArray(commit.parents) || commit.parents.length !== 2
    || !commit.parents.every(parent => SHA.test(parent.sha ?? '')) || commit.parents[1].sha !== pr.head.sha)
    return decline('not_ordinary_pr_merge')
  if (attestation?.status === 'skipped') return decline('inbox_issue_closed')
  let target
  try { target = attestation ? await assertTarget({ env, event, attestation, fetchImpl, now })
    : await attestCoreProduction({ env, event, fetchImpl, now }) }
  catch (error) {
    if (!expectedSelection && error instanceof CoreProductionError && error.code === 'core_target_changed')
      return empty(error.detail === 'main' ? 'main_moved' : 'deployment_changed')
    throw error
  }
  if (target?.status !== 'ready' || !target.openIssues?.includes(1820)) return decline('inbox_issue_closed')
  check(target.applicationSha === guard.applicationSha && (!expectedSelection
    || expectedSelection.purpose === 'inbox-1820-production-selection' && expectedSelection.selected === true
      && expectedSelection.applicationSha === guard.applicationSha && positive(expectedSelection.window?.commentId)
      && /^[a-f0-9]{64}$/.test(expectedSelection.window.markerSha256 ?? '')
      && expectedSelection.headSha === pr.head.sha && expectedSelection.driverRunId === guard.driverRunId
      && expectedSelection.driverRunAttempt === guard.driverRunAttempt), 'inbox_selection_changed', 'target')
  let window
  try { window = await readInboxWindow(read, { headSha: pr.head.sha, sourceSha: guard.applicationSha,
    now, expected: expectedSelection?.window }) }
  catch (error) {
    if (!expectedSelection && error instanceof InboxSelectionError && error.code === 'inbox_window_invalid') return empty('window_not_active')
    throw error
  }
  check(Date.parse(window.expiresAt) > now(), 'inbox_window_invalid', 'time')
  if (window.phase === 'cleanup') check(window.recovery.runId === guard.driverRunId
    && window.recovery.attempt < guard.driverRunAttempt, 'inbox_window_invalid', 'marker')
  return { ...empty('exact_pr_merge_and_active_window'), selected: true, status: 'selected', headSha: pr.head.sha, window, attestation: target }
}
