// One registered Inbox follow-up. This is not an arbitrary-main/PR/stage
// selector, and it does not change the original PR 1822 production selector.
import { createHash } from 'node:crypto'
import { coreProductionGuard, attestCoreProduction, assertCoreProductionTarget, CoreProductionError } from './self-hosted-production-target.mjs'
import { INBOX_PR, INBOX_BRANCH, InboxSelectionError, selectInboxProduction } from './inbox-production-target.mjs'
import { inboxRecoveryReference } from './inbox-production-recovery.mjs'

export const INBOX_FOLLOWUP_PR = 1856
export const INBOX_FOLLOWUP_BRANCH = 'fix/backend-production-followup-1608-1820'
export const INBOX_ORIGINAL_MERGE = '32523d5955479de800a94ba002c551666c4ddeb1'
export const INBOX_ORIGINAL_HEAD = 'a0881b748cd089de08db848e30211fbe8a4a0f48'
const REPOSITORY = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPOSITORY
const MARKER = '<!-- mikka-inbox-followup-1856 '
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const digest = value => createHash('sha256').update(value).digest('hex')
const check = (value, detail, code = 'inbox_selection_invalid') => { if (!value) throw new InboxSelectionError(code, detail) }

// The same closed fixture contract as the original Inbox driver. The source
// stays this follow-up merge: an inventory/nonce from PR 1822 cannot migrate.
function fixtureMetadata(value) {
  const github = value?.github
  check(value?.schema === 1 && value.purpose === 'mikka1820-owner-github-fixture'
    && UUID.test(value.nonce ?? '') && HASH.test(value.ownerHash ?? '') && UUID.test(value.workspaceId ?? '')
    && SHA.test(value.applicationSha ?? '') && positive(value.inventoryRunId) && positive(value.inventoryRunAttempt)
    && typeof value.createdAt === 'string' && value.createdAt.length <= 35 && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.expiresAt === 'string' && value.expiresAt.length <= 35 && Number.isFinite(Date.parse(value.expiresAt))
    && github?.repository === 'alexj11324/Mikka-handoff' && positive(github.issueNumber) && positive(github.eventId)
    && ['assigned', 'issue_comment'].includes(github.kind) && /^[1-9]\d{0,15}$/.test(github.recipientId ?? '')
    && /^[1-9]\d{0,15}$/.test(github.actorId ?? ''), 'marker', 'inbox_window_invalid')
  return { schema: 1, purpose: value.purpose, nonce: value.nonce, ownerHash: value.ownerHash, workspaceId: value.workspaceId,
    applicationSha: value.applicationSha, inventoryRunId: value.inventoryRunId, inventoryRunAttempt: value.inventoryRunAttempt,
    createdAt: value.createdAt, expiresAt: value.expiresAt, github: { repository: github.repository,
      issueNumber: github.issueNumber, eventId: github.eventId, kind: github.kind, recipientId: github.recipientId, actorId: github.actorId } }
}

export function inboxFollowupWindowProof(comment, { headSha, sourceSha, now = Date.now(), expected } = {}) {
  check(positive(comment?.id) && comment.user?.login === 'alexj11324' && typeof comment.body === 'string'
    && comment.body.length <= 65_536 && (!expected || comment.id === expected.commentId), 'comment', 'inbox_window_invalid')
  const matches = [...comment.body.matchAll(/<!-- mikka-inbox-followup-1856 (\{[^\r\n]*\}) -->/g)]
  check(matches.length === 1, 'marker', 'inbox_window_invalid')
  let marker
  try { marker = JSON.parse(matches[0][1]) }
  catch (cause) { throw new InboxSelectionError('inbox_window_invalid', 'marker', { cause }) }
  const allowed = new Set(['schema', 'state', 'issue', 'pr', 'branch', 'headSha', 'sourceSha', 'originPr', 'originMergeSha',
    'originHeadSha', 'startsAt', 'expiresAt', 'phase', 'fixture', 'recovery'])
  check(marker && typeof marker === 'object' && !Array.isArray(marker) && Object.keys(marker).every(key => allowed.has(key))
    && marker.schema === 1 && marker.state === 'active' && marker.issue === 1820
    && marker.pr === INBOX_FOLLOWUP_PR && marker.branch === INBOX_FOLLOWUP_BRANCH
    && SHA.test(headSha ?? '') && marker.headSha === headSha && SHA.test(sourceSha ?? '') && marker.sourceSha === sourceSha
    && marker.originPr === INBOX_PR && marker.originMergeSha === INBOX_ORIGINAL_MERGE && marker.originHeadSha === INBOX_ORIGINAL_HEAD,
  'marker', 'inbox_window_invalid')
  const starts = Date.parse(marker.startsAt), expires = Date.parse(marker.expiresAt)
  check(Number.isFinite(starts) && Number.isFinite(expires) && starts <= now && expires > now
    && expires > starts && expires - starts <= 120 * 60_000, 'time', 'inbox_window_invalid')
  const phase = marker.phase ?? 'inventory'
  check(['inventory', 'fixture', 'cleanup'].includes(phase) && (phase === 'fixture' || marker.fixture === undefined)
    && (phase === 'cleanup' || marker.recovery === undefined), 'marker', 'inbox_window_invalid')
  const fixture = phase === 'fixture' ? fixtureMetadata(marker.fixture) : null
  let recovery = null
  if (phase === 'cleanup') {
    try { recovery = inboxRecoveryReference(marker.recovery) }
    catch (cause) { throw new InboxSelectionError('inbox_window_invalid', 'marker', { cause }) }
  }
  check(!fixture || fixture.applicationSha === sourceSha, 'marker', 'inbox_window_invalid')
  const markerSha256 = digest(matches[0][0])
  check(!expected || expected.markerSha256 === markerSha256 && expected.headSha === headSha && expected.sourceSha === sourceSha,
    'marker', 'inbox_window_invalid')
  return { commentId: comment.id, pr: INBOX_FOLLOWUP_PR, branch: INBOX_FOLLOWUP_BRANCH, headSha, sourceSha,
    originPr: INBOX_PR, originMergeSha: INBOX_ORIGINAL_MERGE, originHeadSha: INBOX_ORIGINAL_HEAD,
    startsAt: marker.startsAt, expiresAt: marker.expiresAt, markerSha256, phase, fixture, recovery }
}

async function readWindow(read, { headSha, sourceSha, now, expected }) {
  const issue = await read('/issues/1752')
  check(Number.isSafeInteger(issue?.comments) && issue.comments > 0, 'window', 'inbox_window_invalid')
  const lastPage = Math.ceil(issue.comments / 100)
  const pages = await Promise.all([...new Set([Math.max(1, lastPage - 1), lastPage])]
    .map(page => read(`/issues/1752/comments?per_page=100&page=${page}`)))
  check(pages.every(page => Array.isArray(page) && page.length <= 100), 'window', 'inbox_window_invalid')
  const latest = pages.flat().filter(comment => comment?.user?.login === 'alexj11324' && positive(comment.id)
    && typeof comment.body === 'string' && comment.body.includes(MARKER)).sort((a, b) => a.id - b.id).at(-1)
  check(latest && (!expected || latest.id === expected.commentId), 'window', 'inbox_window_invalid')
  const comment = await read('/issues/comments/' + latest.id)
  check(comment?.id === latest.id, 'comment', 'inbox_window_invalid')
  return inboxFollowupWindowProof(comment, { headSha, sourceSha, expected, now: now() })
}

const ordinary = (commit, sourceSha, headSha) => commit?.sha === sourceSha && Array.isArray(commit.parents)
  && commit.parents.length === 2 && commit.parents.every(parent => SHA.test(parent.sha ?? ''))
  && commit.parents[0].sha !== commit.parents[1].sha && commit.parents[1].sha === headSha

export async function selectInboxFollowup({ env = process.env, event, attestation, fetchImpl = fetch,
  now = Date.now, expectedSelection, assertTarget = assertCoreProductionTarget } = {}) {
  const guard = coreProductionGuard(env, event)
  const empty = reason => ({ schema: 1, purpose: 'inbox-1820-followup-selection', selected: false, status: 'not_selected', reason,
    issue: 1820, pr: INBOX_FOLLOWUP_PR, branch: INBOX_FOLLOWUP_BRANCH, originPr: INBOX_PR,
    originMergeSha: INBOX_ORIGINAL_MERGE, originHeadSha: INBOX_ORIGINAL_HEAD, ...guard, checkedAt: new Date(now()).toISOString() })
  const decline = reason => {
    check(!expectedSelection, 'target', 'inbox_selection_changed')
    return empty(reason)
  }
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'token')
  const read = async path => {
    const url = API + path
    let response, value
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN, 'x-github-api-version': '2022-11-28' } }) }
    catch (cause) { throw new InboxSelectionError('inbox_selection_read_failed', 'transport', { cause }) }
    check(response.ok && !response.redirected && (!response.url || response.url === url), 'response', 'inbox_selection_read_failed')
    try { value = await response.json() }
    catch (cause) { throw new InboxSelectionError('inbox_selection_read_failed', 'response', { cause }) }
    return value
  }
  const pr = await read('/pulls/' + INBOX_FOLLOWUP_PR)
  if (pr?.number !== INBOX_FOLLOWUP_PR || pr.user?.login !== 'alexj11324'
    || pr.base?.repo?.full_name !== REPOSITORY || pr.base.ref !== 'main' || pr.head?.repo?.full_name !== REPOSITORY
    || pr.head.ref !== INBOX_FOLLOWUP_BRANCH || !SHA.test(pr.head.sha ?? '')) return decline('not_registered_followup')
  if (pr.merged !== true || pr.merge_commit_sha !== guard.applicationSha) return decline('not_followup_merge')
  const commit = await read('/git/commits/' + guard.applicationSha)
  if (!ordinary(commit, guard.applicationSha, pr.head.sha)) return decline('not_ordinary_followup_merge')
  const original = await read('/pulls/' + INBOX_PR)
  if (original?.number !== INBOX_PR || original.merged !== true || original.merge_commit_sha !== INBOX_ORIGINAL_MERGE
    || original.base?.repo?.full_name !== REPOSITORY || original.base.ref !== 'main' || original.head?.repo?.full_name !== REPOSITORY
    || original.head.ref !== INBOX_BRANCH || original.head.sha !== INBOX_ORIGINAL_HEAD) return decline('not_original_inbox_merge')
  if (!ordinary(await read('/git/commits/' + INBOX_ORIGINAL_MERGE), INBOX_ORIGINAL_MERGE, INBOX_ORIGINAL_HEAD))
    return decline('not_original_ordinary_merge')
  // PR base.sha is a moving projection. Walk the actual merge's first-parent
  // history only; finding Inbox in the feature/second parent is insufficient.
  let cursor = commit.parents[0].sha, firstParentDepth = 0
  const seen = new Set()
  while (cursor !== INBOX_ORIGINAL_MERGE && firstParentDepth < 64) {
    if (seen.has(cursor)) return decline('original_not_on_first_parent_chain')
    seen.add(cursor)
    const parent = await read('/git/commits/' + cursor)
    if (parent?.sha !== cursor || !Array.isArray(parent.parents) || ![1, 2].includes(parent.parents.length)
      || !parent.parents.every(row => SHA.test(row.sha ?? ''))) return decline('original_not_on_first_parent_chain')
    cursor = parent.parents[0].sha; firstParentDepth++
  }
  if (cursor !== INBOX_ORIGINAL_MERGE) return decline('original_not_on_first_parent_chain')
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
    || expectedSelection.purpose === 'inbox-1820-followup-selection' && expectedSelection.selected === true
      && expectedSelection.pr === INBOX_FOLLOWUP_PR && expectedSelection.branch === INBOX_FOLLOWUP_BRANCH
      && expectedSelection.applicationSha === guard.applicationSha && expectedSelection.headSha === pr.head.sha
      && expectedSelection.originMergeSha === INBOX_ORIGINAL_MERGE && expectedSelection.originHeadSha === INBOX_ORIGINAL_HEAD
      && expectedSelection.driverRunId === guard.driverRunId && expectedSelection.driverRunAttempt === guard.driverRunAttempt
      && positive(expectedSelection.window?.commentId) && HASH.test(expectedSelection.window.markerSha256 ?? '')),
  'target', 'inbox_selection_changed')
  let window
  try { window = await readWindow(read, { headSha: pr.head.sha, sourceSha: guard.applicationSha, now, expected: expectedSelection?.window }) }
  catch (error) {
    if (!expectedSelection && error instanceof InboxSelectionError && error.code === 'inbox_window_invalid') return empty('window_not_active')
    throw error
  }
  check(Date.parse(window.expiresAt) > now(), 'time', 'inbox_window_invalid')
  if (window.phase === 'cleanup') check(window.recovery.runId === guard.driverRunId && window.recovery.attempt < guard.driverRunAttempt,
    'marker', 'inbox_window_invalid')
  return { ...empty('registered_ordinary_merge_and_active_window'), selected: true, status: 'selected', headSha: pr.head.sha,
    firstParentDepth, window, attestation: target }
}

/** The unchanged workflow has one Inbox step/session. Original 1822 keeps its
 * selector; only an unselected later source may try the one registered repair.
 * Once selected, a withdrawn lease cannot fall through to a different route.
 */
export async function selectInboxAcceptance(args = {}) {
  const expected = args.expectedSelection
  if (expected) {
    check(expected.selected === true, 'target', 'inbox_selection_changed')
    if (expected.purpose === 'inbox-1820-production-selection') return selectInboxProduction(args)
    if (expected.purpose === 'inbox-1820-followup-selection') return selectInboxFollowup(args)
    throw new InboxSelectionError('inbox_selection_changed', 'target')
  }
  const original = await selectInboxProduction(args)
  return original.selected || original.reason !== 'not_pr_1822_merge' ? original : selectInboxFollowup(args)
}
