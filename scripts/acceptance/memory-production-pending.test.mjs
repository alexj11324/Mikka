import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { memoryNotificationDeclaration, verifyMemoryNotification, memoryFixtureInbox, reviewPendingMemoryFixture,
  memoryPendingFailure } from './memory-production-pending.mjs'

const id = n => '60000000-0000-4000-8000-' + String(n).padStart(12, '0')
const OWNER = 'synthetic-test-owner', PERSONAL = id(1), TEAM = id(2), NONCE = id(3), FACT = id(4), NOTICE = id(5), OLD = id(6)
const NOW = Date.parse('2026-11-09T22:00:30Z'), EVENT = '2026-11-09T22:00:00Z'
const URL = 'https://github.com/alexj11324/Mikka/issues/1821#issuecomment-777'
const BODY = 'A normal self-owned notification. mikka-memory-1821:' + NONCE
const hash = value => createHash('sha256').update(value).digest('hex')
const windowOf = (patch = {}) => ({ phase: 'fixture', fixtureNonce: NONCE,
  startsAt: '2026-11-09T21:59:00Z', expiresAt: '2026-11-09T22:30:00Z',
  notification: { provider: 'github', url: URL, bodySha256: hash(BODY) }, ...patch })
const commentOf = (patch = {}) => ({ id: 777, html_url: URL, issue_url: 'https://api.github.com/repos/alexj11324/Mikka/issues/1821',
  created_at: EVENT, updated_at: EVENT, body: BODY, ...patch })
const proof = { provider: 'github', url: URL, bodySha256: hash(BODY), nonce: NONCE, createdAt: EVENT, eventFingerprint: hash('event') }

test('a real public GitHub comment is bound to the exact URL, original body, nonce and whole-second event time', async () => {
  for (const repository of ['alexj11324/Mikka', 'test-owner/fixture']) {
    const url = URL.replace('alexj11324/Mikka', repository), calls = []
    const value = await verifyMemoryNotification(windowOf({ startsAt: '2026-11-09T22:00:00.123Z',
      notification: { provider: 'github', url, bodySha256: hash(BODY) } }), {
      env: { GH_TOKEN: 'synthetic-read-token' }, now: () => NOW,
      fetchImpl: async (input, init) => {
        calls.push(input)
        assert.equal(input, 'https://api.github.com/repos/' + repository + '/issues/comments/777')
        assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
        const headers = new Headers(init.headers)
        assert.equal(headers.has('cookie'), false)
        assert.equal(headers.get('authorization'), repository === 'alexj11324/Mikka' ? 'Bearer synthetic-read-token' : null)
        return Response.json(commentOf({ html_url: url, issue_url: 'https://api.github.com/repos/' + repository + '/issues/1821' }))
      },
    })
    assert.equal(calls.length, 1); assert.equal(value.url, url); assert.equal(value.createdAt, EVENT)
    assert.equal(value.nonce, NONCE); assert.equal(value.bodySha256, hash(BODY)); assert.equal(value.eventFingerprint.length, 64)
    assert.equal(JSON.stringify(value).includes(BODY), false)
  }
})

test('inventory has no provider call; malformed declarations fail before any metadata request', async () => {
  let calls = 0
  assert.equal(await verifyMemoryNotification(windowOf({ phase: 'inventory', notification: undefined }), {
    fetchImpl: () => { calls++; assert.fail('inventory must not fetch a notification') },
  }), null)
  for (const patch of [{ fixtureNonce: 'not-a-nonce' }, { phase: 'another' },
    { phase: 'inventory' }, { notification: { provider: 'slack', url: URL, bodySha256: hash(BODY) } },
    ...['http://github.com/a/b/issues/1#issuecomment-2', 'https://github.com.evil.example/a/b/issues/1#issuecomment-2',
      'https://github.com/../b/issues/1#issuecomment-2', URL + '?copy=1', URL.replace('issuecomment', 'discussion_r')]
      .map(url => ({ notification: { provider: 'github', url, bodySha256: hash(BODY) } })),
    { notification: { provider: 'github', url: URL, bodySha256: hash(BODY), rawBody: BODY } }]) {
    assert.throws(() => memoryNotificationDeclaration(windowOf(patch)), /notification_fixture_invalid/)
  }
  assert.equal(calls, 0)
})

test('edited, stale, future, foreign, relabelled or body-mismatched provider comments cannot establish fixture ownership', async () => {
  for (const patch of [{ id: 778 }, { html_url: URL.replace('1821', '1820') },
    { issue_url: 'https://api.github.com/repos/another/repo/issues/1821' }, { body: BODY + 'edited' },
    { updated_at: '2026-11-09T22:00:01Z' }, { created_at: '2026-11-09T21:58:59Z', updated_at: '2026-11-09T21:58:59Z' },
    { created_at: '2026-11-09T22:00:31Z', updated_at: '2026-11-09T22:00:31Z' }, { created_at: 'invalid', updated_at: 'invalid' }]) {
    await assert.rejects(verifyMemoryNotification(windowOf(), { now: () => NOW,
      fetchImpl: async () => Response.json(commentOf(patch)) }), /notification_fixture_invalid/)
  }
  const noNonce = 'An ordinary unrelated event'
  await assert.rejects(verifyMemoryNotification(windowOf({ notification: { provider: 'github', url: URL, bodySha256: hash(noNonce) } }), {
    now: () => NOW, fetchImpl: async () => Response.json(commentOf({ body: noNonce })),
  }), /notification_fixture_invalid/)
  for (const fetchImpl of [async () => new Response('unavailable', { status: 503 }),
    async () => new Response('not JSON'), async () => { throw new Error('synthetic transport detail must not escape') },
    async () => ({ ok: true, redirected: true, json: () => commentOf() }),
    async () => ({ ok: true, url: 'https://untrusted.example/', json: () => commentOf() })]) {
    await assert.rejects(verifyMemoryNotification(windowOf(), { now: () => NOW, fetchImpl }), error => {
      assert.deepEqual(memoryPendingFailure(error), { code: 'notification_fixture_unreadable' }); return true
    })
  }
})

const notice = (patch = {}) => ({ id: NOTICE, type: 'suggestion', ownerId: OWNER, source: 'github', status: 'pending', pending: true, ...patch })
const inboxPage = (patch = {}) => ({ live: { workspaceId: PERSONAL }, items: [notice()], nextCursor: null, ...patch })

test('normal Inbox pagination preserves the exact owner and workspace without using title text', async () => {
  const paths = []
  const rows = await memoryFixtureInbox(async (_step, path, init) => {
    paths.push(path); assert.equal(init, undefined)
    const query = new globalThis.URL(path, 'https://local.invalid').searchParams
    assert.equal(query.get('workspaceId'), PERSONAL); assert.equal(query.get('tab'), 'pending'); assert.equal(query.get('limit'), '100')
    return paths.length === 1 ? inboxPage({ items: [{ id: id(20), type: 'task' }], nextCursor: 'next' })
      : inboxPage({ items: [notice({ title: 'Provider title omits the nonce' })] })
  }, OWNER, PERSONAL)
  assert.equal(paths.length, 2); assert.equal(rows.length, 1); assert.equal(rows[0].id, NOTICE)
  assert.equal(new globalThis.URL(paths[1], 'https://local.invalid').searchParams.get('cursor'), 'next')
})

test('foreign owners, another workspace, duplicate notices, looping cursors and truncated Inbox pages fail closed', async () => {
  for (const value of [inboxPage({ live: { workspaceId: TEAM } }), inboxPage({ items: [notice({ ownerId: 'someone-else' })] }),
    inboxPage({ items: [notice({ status: 'done' })] }), inboxPage({ items: [notice({ pending: false })] }),
    inboxPage({ items: [notice(), notice()] }), inboxPage({ items: [notice({ id: 'not-an-id' })] }),
    inboxPage({ nextCursor: undefined }), inboxPage({ nextCursor: 'x'.repeat(257) })]) {
    await assert.rejects(memoryFixtureInbox(async () => value, OWNER, PERSONAL), /notification_not_in_inbox/)
  }
  let calls = 0
  await assert.rejects(memoryFixtureInbox(async () => { calls++; return inboxPage({ items: [], nextCursor: 'loop' }) }, OWNER, PERSONAL), /notification_not_in_inbox/)
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(memoryFixtureInbox(async () => inboxPage({ items: [], nextCursor: String(++calls) }), OWNER, PERSONAL), /notification_not_in_inbox/)
  assert.equal(calls, 10)
})

const pendingRow = (patch = {}) => ({ id: FACT, kind: 'preference', subject: 'A newly extracted normal notification fact',
  userEdited: false, reviewStatus: 'pending', usedCount: 0, recentUses: [], scope: { kind: 'global', ids: [] },
  source: { kind: 'thread', id: 'suggestion:' + NOTICE, url: URL },
  createdAt: '2026-11-09T22:00:00.500Z', firstSeenAt: EVENT, ...patch })
const viewOf = (patch = {}) => ({ enabled: true, facts: [], pending: [pendingRow()], undoable: [], ...patch })

test('source, immutable creation time and actual Inbox linkage all precede binding or any Memory mutation', async () => {
  const cases = [
    [viewOf({ pending: [] }), inboxPage(), 'notification_fact_not_arrived'],
    [viewOf({ pending: [pendingRow({ source: { kind: 'thread', id: 'suggestion:' + NOTICE, url: URL + '0' } })] }), inboxPage(), 'notification_fact_not_arrived'],
    [viewOf({ pending: [pendingRow({ source: { kind: 'thread', id: NOTICE, url: URL } })] }), inboxPage(), 'notification_fact_not_arrived'],
    [viewOf({ pending: [pendingRow({ createdAt: '2026-11-09T21:59:59.999Z' })] }), inboxPage(), 'notification_fact_not_new'],
    [viewOf({ pending: [pendingRow({ firstSeenAt: '2026-11-08T22:00:00Z' })] }), inboxPage(), 'notification_fact_not_new'],
    [viewOf({ pending: [pendingRow({ createdAt: undefined })] }), inboxPage(), 'notification_fact_not_new'],
    [viewOf({ pending: [pendingRow({ createdAt: '2026-11-09T22:00:31Z' })] }), inboxPage(), 'notification_fact_not_new'],
    [viewOf(), inboxPage({ items: [] }), 'notification_not_in_inbox'],
    [viewOf(), inboxPage({ items: [notice({ id: id(90) })] }), 'notification_not_in_inbox'],
    [viewOf(), inboxPage({ items: [notice({ source: 'slack' })] }), 'notification_not_in_inbox'],
    [viewOf({ facts: [pendingRow({ id: id(91), reviewStatus: 'approved', userEdited: true })] }), inboxPage(), 'notification_fact_ambiguous'],
    [viewOf({ pending: [1, 2, 3, 4].map(n => pendingRow({ id: id(30 + n) })) }), inboxPage(), 'notification_fact_ambiguous'],
  ]
  for (const [view, page, code] of cases) {
    let bound = 0, writes = 0
    await assert.rejects(reviewPendingMemoryFixture({ proof, ownerId: OWNER, workspaceId: PERSONAL, otherWorkspaceId: TEAM,
      now: () => NOW, readMemory: async () => view, request: async () => page, report: {},
      bind: () => { bound++ }, rpc: () => { writes++; assert.fail('unproved fact must not be mutated') },
      switchWorkspace: () => { writes++; assert.fail('unproved fixture must not change workspace') },
      cleanupStep: () => assert.fail('no cleanup is authorized before fixture ownership'), saveReceipt: () => assert.fail('not bound'),
    }), new RegExp(code))
    assert.equal(bound, 0); assert.equal(writes, 0)
  }
})

function lifecycle({ failReceipt = false, failInboxCleanup = false } = {}) {
  const old = pendingRow({ id: OLD, subject: 'Existing owner pending item', source: null, createdAt: '2026-01-01T00:00:00Z', firstSeenAt: '2026-01-01T00:00:00Z' })
  let current = PERSONAL, row = pendingRow(), removed = false, dismissed = false, snapshot
  const bound = new Set(), calls = [], failures = [], report = {}, receipt = []
  const readMemory = async () => current === PERSONAL
    ? viewOf({ pending: [old, ...(!removed && row.reviewStatus === 'pending' ? [row] : [])],
      facts: !removed && row.reviewStatus === 'approved' ? [row] : [], undoable: removed ? [{ ...row, source: null }] : [] })
    : viewOf({ pending: [old] })
  const rpc = async (action, args) => {
    calls.push({ action, args, workspace: current }); assert.ok(bound.has(args[0])); assert.notEqual(args[0], OLD)
    if (current !== PERSONAL) return false
    if (action === 'memory.setFactScope') { row = { ...row, scope: args[1] }; return true }
    if (action === 'memory.removeFact' || action === 'memory.reviewFact' && args[1] === 'reject') {
      snapshot = structuredClone(row); removed = true; return true
    }
    if (action === 'memory.undoRemoveFact') { row = snapshot; removed = false; return true }
    if (action === 'memory.reviewFact' && args[1] === 'approve') { row = { ...row, userEdited: true, reviewStatus: 'approved' }; return true }
    return assert.fail('Unexpected mutation ' + action)
  }
  const request = async (_step, _path, init) => {
    assert.equal(current, PERSONAL)
    if (init) {
      const body = JSON.parse(init.body)
      assert.deepEqual(body, { workspaceId: PERSONAL, type: 'suggestion', id: NOTICE, action: 'reject' })
      if (failInboxCleanup) throw new Error('synthetic cleanup transport failure')
      dismissed = true; return { changed: true }
    }
    return inboxPage({ items: dismissed ? [] : [notice()] })
  }
  const args = { proof, ownerId: OWNER, workspaceId: PERSONAL, otherWorkspaceId: TEAM, now: () => NOW,
    readMemory, rpc, request, report, switchWorkspace: async id => { assert.ok([PERSONAL, TEAM].includes(id)); current = id },
    bind: value => { assert.equal(value.id, FACT); bound.add(value.id) },
    saveReceipt: async () => { receipt.push(true); if (failReceipt) throw new Error('synthetic journal unavailable') },
    cleanupStep: async (step, work) => { try { await work() } catch (error) { failures.push({ step, error }) } },
  }
  return { args, report, calls, failures, receipt, old, readMemory, get dismissed() { return dismissed } }
}

test('a verified new pending fact uses normal reject, undo and approve, preserves old pending, then removes only its source notice', async () => {
  const f = lifecycle(), before = structuredClone(f.old)
  await reviewPendingMemoryFixture(f.args)
  assert.equal(f.report.status, 'passed'); assert.equal(f.report.pendingRestoredByNormalUndo, true)
  assert.equal(f.report.scopeRejectedOutsideSourceWorkspace, true); assert.equal(f.report.approvalIdempotent, true)
  assert.equal(f.report.cleaned, true); assert.equal(f.report.inboxCleaned, true); assert.equal(f.report.otherFactsPreserved, true)
  assert.equal(f.failures.length, 0); assert.equal(f.receipt.length, 2); assert.equal(f.dismissed, true)
  assert.deepEqual((await f.readMemory()).pending, [before])
  assert.deepEqual(f.calls.filter(call => call.workspace === TEAM).map(call => call.args[1]), ['approve', 'reject'])
})

test('journal and source cleanup failures cannot produce pass or leave newly bound facts unattempted', async () => {
  for (const options of [{ failReceipt: true }, { failInboxCleanup: true }]) {
    const f = lifecycle(options)
    await assert.rejects(reviewPendingMemoryFixture(f.args))
    assert.notEqual(f.report.status, 'passed')
    assert.ok(f.calls.some(call => call.action === 'memory.removeFact' && call.args[0] === FACT))
    assert.equal(f.report.cleaned, true)
    assert.deepEqual((await f.readMemory()).pending.map(row => row.id), [OLD])
    assert.ok(f.failures.length > 0)
  }
})
