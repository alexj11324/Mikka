// Consume a real notification that arrived through the normal provider path.
// Nothing here emits a webhook, creates a fact, invokes extraction or changes
// an existing pending item. Source proof is the current window's exact event.
import { createHash } from 'node:crypto'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const DIGEST = /^[a-f0-9]{64}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const codes = new Set(['notification_fixture_invalid', 'notification_fixture_unreadable', 'notification_not_in_inbox',
  'notification_fact_not_arrived', 'notification_fact_not_new', 'notification_fact_ambiguous', 'pending_scope_failed', 'pending_review_failed',
  'pending_cleanup_failed', 'pending_baseline_changed'])
export class MemoryPendingError extends Error {
  constructor(code, options) { super(codes.has(code) ? code : 'notification_fixture_invalid', options); this.code = this.message }
}
const check = (value, code = 'notification_fixture_invalid') => { if (!value) throw new MemoryPendingError(code) }
export const memoryPendingFailure = error => error instanceof MemoryPendingError ? { code: error.code } : null

/** This fixture is declared in the same exact, owner-authored release marker.
 * The URL identifies a real issue comment; its immutable original body hash
 * and nonce prevent adopting another notification or an edited source. */
export function memoryNotificationDeclaration(marker) {
  check(UUID.test(marker?.fixtureNonce ?? '') && ['inventory', 'fixture'].includes(marker.phase))
  if (marker.phase === 'inventory') { check(marker.notification === undefined); return null }
  const value = marker.notification
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'bodySha256,provider,url'
    && value.provider === 'github' && typeof value.url === 'string' && DIGEST.test(value.bodySha256 ?? ''))
  const match = value.url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)#issuecomment-([1-9][0-9]*)$/)
  check(match && match[1].split('/').every(part => part !== '.' && part !== '..') && value.url.length <= 500)
  return { provider: 'github', url: value.url, bodySha256: value.bodySha256, nonce: marker.fixtureNonce,
    repository: match[1], issueNumber: match[3], commentId: match[4] }
}

/** Read only real GitHub metadata. No provider write token or account cookie
 * is needed for the public fixture; GH_TOKEN is sent only to this repository.
 * Bodies, usernames and comment text never leave the closed proof. */
export async function verifyMemoryNotification(window, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const fixture = memoryNotificationDeclaration(window)
  if (!fixture) return null
  const endpoint = `https://api.github.com/repos/${fixture.repository}/issues/comments/${fixture.commentId}`
  let response, comment
  try {
    response = await fetchImpl(endpoint, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(fixture.repository.toLowerCase() === 'alexj11324/mikka' && env.GH_TOKEN ? { authorization: 'Bearer ' + env.GH_TOKEN } : {}) } })
    check(response.ok && !response.redirected && (!response.url || response.url === endpoint), 'notification_fixture_unreadable')
    comment = await response.json()
  } catch (cause) { throw new MemoryPendingError('notification_fixture_unreadable', { cause }) }
  const created = Date.parse(comment?.created_at)
  check(String(comment?.id) === fixture.commentId && comment.html_url === fixture.url
    && comment.issue_url === `https://api.github.com/repos/${fixture.repository}/issues/${fixture.issueNumber}`
    && typeof comment.body === 'string' && comment.body.length <= 65_536
    && hash(comment.body) === fixture.bodySha256 && comment.body.includes('mikka-memory-1821:' + fixture.nonce)
    && comment.updated_at === comment.created_at && Number.isFinite(created)
    // GitHub records this event only to whole seconds. Compare its lower bound
    // at that same precision; the original nonce/body/source remain exact.
    && created >= Math.floor(Date.parse(window.startsAt) / 1000) * 1000
    && created <= now() && created < Date.parse(window.expiresAt))
  return { provider: fixture.provider, url: fixture.url, bodySha256: fixture.bodySha256, nonce: fixture.nonce,
    createdAt: comment.created_at, eventFingerprint: hash('github-issue-comment\0' + fixture.repository + '\0' + fixture.commentId) }
}

/** Bounded pagination is a single collection read, not a notification polling
 * loop. A hidden/low-ranked notice is not guessed from another Inbox title. */
export async function memoryFixtureInbox(request, ownerId, workspaceId) {
  const seen = new Set(), rows = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ workspaceId, tab: 'pending', limit: '100', ...(cursor ? { cursor } : {}) })
    const value = await request('pending_fixture_inbox', '/api/inbox?' + query)
    check(value?.live?.workspaceId === workspaceId && Array.isArray(value.items) && value.items.length <= 100
      && value.items.every(row => UUID.test(row?.id ?? '') && ['task', 'suggestion'].includes(row.type)), 'notification_not_in_inbox')
    for (const row of value.items) {
      if (row.type !== 'suggestion') continue
      check(row.ownerId === ownerId && row.status === 'pending' && row.pending === true, 'notification_not_in_inbox')
      check(!rows.some(previous => previous.id === row.id), 'notification_not_in_inbox')
      rows.push(row)
    }
    if (value.nextCursor === null) return rows
    check(typeof value.nextCursor === 'string' && value.nextCursor.length <= 256 && !seen.has(value.nextCursor), 'notification_not_in_inbox')
    seen.add(value.nextCursor); cursor = value.nextCursor
  }
  throw new MemoryPendingError('notification_not_in_inbox')
}

const allRows = view => [...view.facts, ...view.pending, ...view.undoable]
const identity = row => JSON.stringify([row.id, row.kind, row.subject, row.userEdited, row.reviewStatus, row.source, row.scope])

/** The caller owns the session and exact window guard. bind() records only a
 * source-verified new fixture and is the sole way to permit its RPC mutations.
 * Normal API rejection of an unrelated ID is tested without changing it. */
export async function reviewPendingMemoryFixture({ proof, ownerId, workspaceId, otherWorkspaceId,
  readMemory, request, rpc, switchWorkspace, cleanupStep, bind, saveReceipt, report, now = Date.now }) {
  check(proof?.provider === 'github' && UUID.test(proof.nonce) && UUID.test(workspaceId) && UUID.test(otherWorkspaceId)
    && workspaceId !== otherWorkspaceId)
  const before = await readMemory(), inbox = await memoryFixtureInbox(request, ownerId, workspaceId)
  const candidates = before.pending.filter(row => row.source?.kind === 'thread' && row.source.url === proof.url
    && /^suggestion:[a-f0-9-]{36}$/i.test(row.source.id ?? '') && row.reviewStatus === 'pending' && row.userEdited === false
    && row.usedCount === 0 && row.recentUses.length === 0)
  check(candidates.length > 0, 'notification_fact_not_arrived')
  const eventAt = Date.parse(proof.createdAt)
  check(Number.isFinite(eventAt) && candidates.every(row => Number.isFinite(Date.parse(row.createdAt))
    && Date.parse(row.createdAt) >= eventAt && Date.parse(row.createdAt) <= now()
    && Date.parse(row.firstSeenAt) === eventAt), 'notification_fact_not_new')
  check(candidates.length <= 3 && new Set(candidates.map(row => row.id)).size === candidates.length, 'notification_fact_ambiguous')
  const noticeIds = [...new Set(candidates.map(row => row.source.id.slice('suggestion:'.length)))]
  check(noticeIds.length === 1 && UUID.test(noticeIds[0]) && inbox.some(row => row.id === noticeIds[0] && row.source === 'github'), 'notification_not_in_inbox')
  // A mixed approved/pending batch is not silently adopted after a prior edit.
  check(before.facts.every(row => row.source?.url !== proof.url), 'notification_fact_ambiguous')
  const bound = candidates.map(row => ({ ...row, scope: { ...row.scope, ids: [...row.scope.ids] } }))
  for (const row of bound) bind(row, workspaceId, noticeIds[0])
  report.fixture = { provider: 'github', eventFingerprint: proof.eventFingerprint, sourceLinkVerified: true,
    suggestionFingerprint: hash(noticeIds[0]), ownedFactCount: bound.length, pendingBeforeReview: true }
  const target = bound[0]
  const exact = view => {
    const row = allRows(view).find(row => row.id === target.id)
    check(row && row.kind === target.kind && row.subject === target.subject, 'pending_review_failed')
    return row
  }
  try {
    await saveReceipt()
    check(await rpc('memory.setFactScope', [target.id, { kind: 'workspaces', ids: [workspaceId] }]) === true, 'pending_scope_failed')
    const scoped = exact(await readMemory())
    check(scoped.scope.kind === 'workspaces' && scoped.scope.ids.length === 1 && scoped.scope.ids[0] === workspaceId, 'pending_scope_failed')
    try {
      await switchWorkspace(otherWorkspaceId)
      check(!allRows(await readMemory()).some(row => row.id === target.id), 'pending_scope_failed')
      check(await rpc('memory.reviewFact', [target.id, 'approve']) === false
        && await rpc('memory.reviewFact', [target.id, 'reject']) === false, 'pending_scope_failed')
      report.scopeRejectedOutsideSourceWorkspace = true
    } finally { await cleanupStep('restore_pending_source_workspace', () => switchWorkspace(workspaceId)) }
    check(await rpc('memory.reviewFact', [target.id, 'reject']) === true, 'pending_review_failed')
    let current = await readMemory()
    check(!current.pending.some(row => row.id === target.id) && !current.facts.some(row => row.id === target.id)
      && current.undoable.some(row => row.id === target.id) && exact(current).source === null, 'pending_review_failed')
    report.rejected = true
    check(await rpc('memory.undoRemoveFact', [target.id]) === true, 'pending_review_failed')
    current = await readMemory()
    const restored = exact(current)
    check(current.pending.some(row => row.id === target.id) && restored.reviewStatus === 'pending' && !restored.userEdited
      && restored.source?.id === target.source.id && restored.source.url === proof.url, 'pending_review_failed')
    report.pendingRestoredByNormalUndo = true
    check(await rpc('memory.reviewFact', [target.id, 'approve']) === true, 'pending_review_failed')
    current = await readMemory()
    const approved = exact(current)
    check(!current.pending.some(row => row.id === target.id) && current.facts.some(row => row.id === target.id)
      && approved.reviewStatus === 'approved' && approved.userEdited && approved.source?.id === target.source.id
      && approved.source.url === proof.url && approved.usedCount === 0, 'pending_review_failed')
    report.approved = true
    check(await rpc('memory.reviewFact', [target.id, 'approve']) === true, 'pending_review_failed')
    report.approvalIdempotent = true
  } finally {
    await cleanupStep('remove_notification_owned_facts', async () => {
      await switchWorkspace(workspaceId)
      for (const row of bound) {
        const current = allRows(await readMemory()).find(candidate => candidate.id === row.id)
        check(current && current.subject === row.subject && current.kind === row.kind, 'pending_cleanup_failed')
        check(await rpc('memory.removeFact', [row.id]) === true, 'pending_cleanup_failed')
      }
      const after = await readMemory(), ownedIds = new Set(bound.map(row => row.id))
      check([...after.facts, ...after.pending].every(row => !ownedIds.has(row.id)), 'pending_cleanup_failed')
      check(after.undoable.filter(row => ownedIds.has(row.id)).every(row => row.source === null), 'pending_cleanup_failed')
      report.cleaned = true
      report.otherFactsPreserved = [...before.facts, ...before.pending].filter(row => !ownedIds.has(row.id))
        .every(row => [...after.facts, ...after.pending].some(next => identity(next) === identity(row)))
      check(report.otherFactsPreserved && before.enabled === after.enabled, 'pending_baseline_changed')
      await saveReceipt()
    })
    // Only this event's exact owner-scoped notice is removed from the Inbox.
    // There is no shared Coordinator stop, task dispatch or other suggestion edit.
    await cleanupStep('reject_notification_owned_inbox_item', async () => {
      await switchWorkspace(workspaceId)
      const current = await memoryFixtureInbox(request, ownerId, workspaceId)
      check(current.some(row => row.id === noticeIds[0] && row.source === 'github'), 'pending_cleanup_failed')
      const result = await request('pending_fixture_inbox_cleanup', '/api/inbox', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, type: 'suggestion', id: noticeIds[0], action: 'reject' }) })
      check(result && typeof result.changed === 'boolean', 'pending_cleanup_failed')
      check(!(await memoryFixtureInbox(request, ownerId, workspaceId)).some(row => row.id === noticeIds[0]), 'pending_cleanup_failed')
      report.inboxCleaned = true
    })
  }
  check(report.rejected && report.pendingRestoredByNormalUndo && report.approved && report.approvalIdempotent
    && report.scopeRejectedOutsideSourceWorkspace && report.cleaned && report.inboxCleaned && report.otherFactsPreserved, 'pending_review_failed')
  report.status = 'passed'
  return report
}
