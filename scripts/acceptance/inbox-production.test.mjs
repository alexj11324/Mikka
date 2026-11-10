import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { InboxSelectionError } from './inbox-production-target.mjs'
import { InboxRecoveryError, inboxBindingJournal } from './inbox-production-recovery.mjs'
import { INBOX_FOLLOWUP_BRANCH, INBOX_ORIGINAL_HEAD, INBOX_ORIGINAL_MERGE } from './self-hosted-production-followup-target.mjs'
import { inboxLiveSocket, inboxProductionExitCode, readInboxFactoryInventory, runInboxProduction, verifyInboxFixture } from './inbox-production.mjs'

const SHA = 'a'.repeat(40), NOW = Date.parse('2026-11-09T22:00:00.000Z')
const OWNER = 'private-owner-canary', EMAIL = 'fixture+mikka-smoke@example.invalid'
const PASSWORD = 'private-password-canary', COOKIE = 'private-cookie-canary'
const OLD_SESSION = 'private-old-session-canary', OLD_TOKEN = 'private-old-session-token-canary-32', OTHER_SESSION = 'private-unrelated-session-canary'
const TEAM = '10000000-0000-4000-8000-000000000001', HOME = '10000000-0000-4000-8000-000000000002'
const ITEM = '20000000-0000-4000-8000-000000000001', HISTORICAL = '20000000-0000-4000-8000-000000000002'
const ISSUE = '30000000-0000-4000-8000-000000000001', TASK_PR = '40000000-0000-4000-8000-000000000001'
const TASK_EMPTY = '40000000-0000-4000-8000-000000000002', NONCE = '50000000-0000-4000-8000-000000000001'
const OTHER_TEAM = '10000000-0000-4000-8000-000000000003'
const LATER_ISSUE = '30000000-0000-4000-8000-000000000002'
const OTHER_TASKS = Array.from({ length: 5 }, (_, index) => '40000000-0000-4000-8000-' + String(index + 10).padStart(12, '0'))
const hash = value => createHash('sha256').update(value).digest('hex')
const marker = `<!-- mikka-inbox-1820:${NONCE} -->`
const PUBLIC_ISSUE = 'https://github.com/alexj11324/Mikka-handoff/issues/73'
const SOURCE = PUBLIC_ISSUE + '#issuecomment-91'
const API_ISSUE = 'https://api.github.com/repos/alexj11324/Mikka-handoff/issues/73'
const fixtureManifest = () => ({ schema: 1, purpose: 'mikka1820-owner-github-fixture', nonce: NONCE,
  ownerHash: hash(OWNER), workspaceId: HOME, applicationSha: SHA, inventoryRunId: 123, inventoryRunAttempt: 1, createdAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW + 600_000).toISOString(),
  github: { repository: 'alexj11324/Mikka-handoff', issueNumber: 73, eventId: 91, kind: 'issue_comment', recipientId: '42', actorId: '7' } })
const sourceIssue = () => ({ number: 73, url: API_ISSUE, html_url: PUBLIC_ISSUE, body: marker,
  created_at: new Date(NOW - 120_000).toISOString(), state: 'closed', closed_at: new Date(NOW - 30_000).toISOString(), user: { id: 42 } })
const sourceComment = () => ({ id: 91, issue_url: API_ISSUE, html_url: SOURCE, body: marker,
  created_at: new Date(NOW - 60_000).toISOString(), user: { id: 7 } })
const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers })

class Socket extends EventTarget {
  readyState = 0
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); this.frame({ type: 'live_ready', version: 1, kinds: ['issue_list', 'pending_actions'] }) }) }
  frame(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  send(value) { assert.equal(value, 'ping'); this.dispatchEvent(new MessageEvent('message', { data: 'pong' })) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

function fixture(options = {}) {
  const calls = [], receipts = [], history = [], mutations = [], sockets = []
  const flowReads = new Map()
  let clock = NOW, loggedIn = false, selected = HOME, snoozedUntil = null, rejectedAt = null, due = false, versionReads = 0
  let oldSessionPresent = options.originalSessionAbsent !== true
  if (options.recovery) {
    selected = TEAM
    if (options.recovery === 'snoozed') snoozedUntil = new Date(NOW + 120_000).toISOString()
    if (options.recovery === 'done') {
      rejectedAt = new Date(NOW - 60_000).toISOString()
      history.push({ id: '60000000-0000-4000-8000-000000000001', action: 'rejected', actorId: OWNER, at: rejectedAt, runId: null })
    }
  }
  const keys = (at = clock) => { clock = at; for (const socket of sockets) for (const kind of ['issue_list', 'pending_actions']) socket.frame({ kind, id: HOME }) }
  const row = (id = ITEM, done = false) => ({ id, type: 'suggestion', source: 'github', title: id === HISTORICAL ? 'existing private title canary' : 'action title changed by model',
    ownerId: OWNER, issueId: null, runId: null, reason: null, pending: id === HISTORICAL || rejectedAt === null, canReply: false,
    status: done ? 'done' : snoozedUntil && id === ITEM ? 'snoozed' : 'pending',
    snoozedUntil: id === ITEM ? snoozedUntil : null, rejectedAt: id === ITEM ? rejectedAt : null, rejectedBy: id === ITEM && rejectedAt ? OWNER : null,
    actions: done ? rejectedAt ? ['undo_reject'] : [] : ['accept', 'reject', snoozedUntil && id === ITEM ? 'reopen' : 'snooze'] })
  const flow = id => ({ version: 2, id, issueId: options.extendedFactory && id !== TASK_EMPTY ? LATER_ISSUE : ISSUE, revision: 4, stage: id === TASK_PR ? 'handoff' : 'implement',
    ...(id === TASK_PR ? { needsYou: { kind: 'pr_review', since: new Date(NOW).toISOString() } } : {}),
    pullRequest: id === TASK_PR ? { url: 'https://github.com/alexj11324/Mikka-handoff/pull/61', state: 'open' } : null,
    review: id === TASK_PR ? { candidateId: NONCE, currentCandidateReviewed: true, verdict: 'passed', summary: {
      branch: 'private-branch-canary', additions: 4, deletions: 1, changedFiles: 1, headSha: SHA,
      checks: options.unknownChecks ? null : { passed: 3, failed: 0, pending: 0, skipped: 0 },
      checksUpdatedAt: options.unknownChecks ? null : new Date(NOW - 10_000).toISOString(),
    } } : options.nonNullNoPr ? { summary: { branch: 'invalid' } } : null })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), path = url.pathname.replace(/^\/mikka/, ''), method = init.method ?? 'GET'
    const headers = new Headers(init.headers), body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method, workspaceHeader: headers.get('x-mikka-workspace-id'), search: url.search }); assert.equal(init.redirect, 'error')
    if (url.origin === 'https://api.github.com') {
      assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false)
      if (path.endsWith('/issues/73')) return response({ ...sourceIssue(), ...(options.sourceOwner ? { user: { id: 99 } } : {}) })
      if (path.endsWith('/issues/comments/91')) return response(sourceComment())
      assert.fail('Unexpected public metadata path')
    }
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    if (path === '/api/version') return response({ build: options.changedClosingBuild && ++versionReads >= 3 ? 'b'.repeat(40) : SHA })
    if (path === '/api/auth/sign-in/email') {
      assert.deepEqual(body, { email: EMAIL, password: PASSWORD, rememberMe: false }); loggedIn = true
      return response({ user: { id: OWNER } }, 200, { 'set-cookie': 'session=' + COOKIE + '; Path=/; HttpOnly' })
    }
    if (path === '/api/auth/get-session') return response(loggedIn && headers.get('cookie')?.includes(COOKIE)
      ? { user: { id: OWNER, email: EMAIL }, session: { id: 'private-session-canary' } } : null)
    assert.ok(loggedIn && headers.get('cookie')?.includes(COOKIE))
    if (path === '/api/auth/list-sessions') return response([
      { id: 'private-session-canary', userId: OWNER, token: 'private-current-session-token-canary' },
      { id: OTHER_SESSION, userId: OWNER, token: 'private-unrelated-session-token-canary' },
      ...(oldSessionPresent ? [{ id: OLD_SESSION, userId: OWNER, token: OLD_TOKEN }] : []),
    ])
    if (path === '/api/auth/revoke-session') {
      assert.equal(body.token, OLD_TOKEN); assert.equal(receipts[0]?.state, 'recovery_bound_before_cleanup')
      if (!options.ignoreOldSessionRevoke) oldSessionPresent = false
      return response({ status: true })
    }
    if (path === '/api/auth/sign-out') { if (!options.ignoreLogout) loggedIn = false; return response({ success: true }, 200, { 'set-cookie': 'session=; Path=/; Max-Age=0' }) }
    if (path === '/api/rpc') {
      assert.equal(body.action, 'workspace.switchWorkspace'); assert.ok([TEAM, HOME].includes(body.args[0])); selected = body.args[0]
      return response({ version: 1, ok: true, result: { ok: true, data: { workspaceId: selected } } })
    }
    if (path === '/api/workspace') return response({ currentUserId: OWNER, workspace: { id: selected, kind: selected === HOME ? 'personal' : 'team' },
      choices: [{ id: HOME, kind: 'personal' }, { id: TEAM, kind: 'team' }, ...(options.extendedFactory ? [{ id: OTHER_TEAM, kind: 'team' }] : [])] })
    if (path === '/api/auth/list-accounts') return response(options.noGitHub || options.cloudIdentity ? [] : [{ providerId: 'github', accountId: '42', userId: OWNER }])
    if (path === '/api/integrations/github') return response({ ...(options.cloudIdentity ? { githubAccountId: '42', source: 'cloud', login: null } : {}),
      viewerId: OWNER, connected: Boolean(options.cloudIdentity), configured: true, installed: Boolean(options.cloudIdentity),
      repositories: options.cloudIdentity ? [{ fullName: 'alexj11324/Mikka-handoff' }] : [] })
    if (path === '/api/issues/search') {
      if (options.extendedFactory) {
        const workspace = url.searchParams.get('workspaceId'), cursor = url.searchParams.get('cursor')
        assert.equal(workspace, TEAM)
        return response({ items: [{ id: cursor ? LATER_ISSUE : ISSUE }], nextCursor: cursor ? null : 'issue-next', truncated: false })
      }
      return response({ items: options.repeatIssueCursor ? [] : [{ id: ISSUE }], nextCursor: options.repeatIssueCursor ? 'same-cursor' : null, truncated: false })
    }
    if (path === '/api/factory/tasks') {
      const issueId = url.searchParams.get('issueId'), workspace = headers.get('x-mikka-workspace-id')
      let tasks = options.noFactory ? [] : [{ id: TASK_PR }, { id: TASK_EMPTY }]
      if (options.extendedFactory) {
        assert.ok([ISSUE, LATER_ISSUE].includes(issueId))
        tasks = issueId === ISSUE ? [{ id: TASK_EMPTY }] : [...OTHER_TASKS, TASK_PR].map(id => ({ id }))
      }
      return response({ issueId, liveWorkspaceId: workspace ?? TEAM, tasks })
    }
    const task = /^\/api\/factory\/tasks\/([^/]+)\/flow$/.exec(path)
    if (task) {
      assert.equal(method, 'GET')
      const count = (flowReads.get(task[1]) ?? 0) + 1; flowReads.set(task[1], count)
      const value = flow(task[1])
      if (options.changedReadback && task[1] === TASK_PR && count > 1) { value.stage = 'implement'; delete value.needsYou }
      return response(value)
    }
    if (path === '/api/suggestions') return response({ groups: [{ source: 'github', items: options.noSuggestion ? [] : [{ id: ITEM, source: 'github', action: 'reply', required: false,
      url: options.wrongSourceUrl ? PUBLIC_ISSUE + '#issuecomment-90' : SOURCE, occurredAt: sourceComment().created_at }] }], inProgress: [] })
    if (path === '/api/live/ticket') {
      assert.equal(url.searchParams.get('workspace'), HOME)
      const expiry = Math.floor((clock + 300_000) / 1000) * 1000
      return response({ url: 'wss://mikka-gateway.aspectlylabs.com/v1/live/' + hash(JSON.stringify([OWNER, HOME])) + '/socket',
        protocol: 'mikka-ticket-' + expiry / 1000 + '-' + 'c'.repeat(64), expiresAt: expiry })
    }
    if (path === '/api/inbox') {
      if (method === 'GET') {
        const tab = url.searchParams.get('tab'), workspace = url.searchParams.get('workspaceId')
        let items = []
        if (workspace === HOME) {
          if (tab === 'pending') items = [row(HISTORICAL), ...(!rejectedAt && !snoozedUntil && !options.noSuggestion ? [row()] : [])]
          if (tab === 'snoozed' && snoozedUntil) items = [row()]
          if (tab === 'done') items = history.map(completion => ({ ...row(ITEM, true), completion }))
        }
        if (options.recoveryMissing) items = items.filter(item => item.id !== ITEM)
        const result = response({ items, nextCursor: null, historySince: new Date(NOW - 600_000).toISOString(), historyBackfilled: false,
          live: { workspaceId: workspace, keys: ['issue_list', 'pending_actions'] } })
        if (due && tab === 'snoozed' && items.length) {
          due = false
          // A deterministic real-time boundary: the first snoozed read is the
          // final state before the fake peer's deadline invalidation, no timer polling.
          setTimeout(() => { const expiry = Date.parse(snoozedUntil); snoozedUntil = null; keys(expiry) }, 0)
        }
        return result
      }
      assert.equal(method, 'POST'); assert.equal(body.id, ITEM); assert.equal(body.workspaceId, HOME); assert.equal(body.type, 'suggestion')
      assert.ok(['bound_before_mutation', 'recovery_bound_before_cleanup'].includes(receipts[0]?.state), 'a completed journal write must precede every fixture mutation')
      mutations.push(body.action)
      if (options.cleanupFailure && mutations.length > 8 && body.action === 'reject') return response({ error: 'inboxConflict', raw: PASSWORD, cookie: COOKIE }, 500)
      let changed = false
      if (body.action === 'snooze') { changed = snoozedUntil !== body.until; snoozedUntil = body.until; due = Date.parse(body.until) - clock === 20_000 }
      if (body.action === 'reopen') { changed = snoozedUntil !== null; snoozedUntil = null }
      if (body.action === 'reject') {
        changed = rejectedAt === null; rejectedAt ??= new Date(clock).toISOString(); snoozedUntil = null
        if (changed || options.duplicateReceipts) history.push({ id: '60000000-0000-4000-8000-' + String(history.length + 1).padStart(12, '0'),
          action: 'rejected', actorId: OWNER, at: new Date(clock).toISOString(), runId: null })
      }
      if (body.action === 'undo_reject') { changed = rejectedAt !== null; rejectedAt = null }
      if (changed) keys()
      if (options.lostWrite && mutations.length === 1) throw new Error(PASSWORD + COOKIE)
      return response({ changed })
    }
    assert.fail('Unexpected API path ' + path)
  }
  const reference = { schema: 1, purpose: 'mikka1820-journal-recovery', runId: 123, attempt: 1, jobId: 71, journalSha256: 'e'.repeat(64) }
  const args = { env: { SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: options.recovery ? '2' : '1' },
    event: {}, attestation: {}, fetchImpl, now: () => clock,
    selectTarget: async ({ assertTarget }) => {
      if (options.windowLost && mutations.length) throw new InboxSelectionError('inbox_window_invalid', 'marker')
      return { purpose: options.followup ? 'inbox-1820-followup-selection' : 'inbox-1820-production-selection', selected: true,
        ...(options.followup ? { pr: 1856, branch: INBOX_FOLLOWUP_BRANCH, originMergeSha: INBOX_ORIGINAL_MERGE, originHeadSha: INBOX_ORIGINAL_HEAD } : {}),
        applicationSha: SHA, headSha: 'b'.repeat(40),
        driverRunId: 123, driverRunAttempt: options.recovery ? 2 : 1,
        window: { commentId: 5, markerSha256: 'c'.repeat(64), phase: options.recovery ? 'cleanup' : options.inventoryOnly ? 'inventory' : 'fixture',
          expiresAt: new Date(NOW + 1200_000).toISOString(), fixture: options.inventoryOnly || options.recovery ? null
            : { ...fixtureManifest(), ...(options.oldFollowupFixture ? { applicationSha: INBOX_ORIGINAL_MERGE } : {}) },
          recovery: options.recovery ? reference : null },
        attestation: await assertTarget({}) }
    },
    assertTarget: async () => ({ status: 'ready', applicationSha: SHA, driverRunId: 123, openIssues: [1820] }),
    selectTeam: async (client, { ownerId }, remember) => { assert.equal(ownerId, OWNER); remember(HOME); await client.rpc('workspace.switchWorkspace', [TEAM]); return { workspaceId: TEAM } },
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket },
    readRecovery: async () => {
      if (options.recoveryProofFailure) throw new InboxRecoveryError('recovery_log_invalid')
      return { reference, proof: { source: 'completed_github_job_log', originalAttempt: 1, journalSha256: reference.journalSha256 },
        journal: inboxBindingJournal({ schema: 1, purpose: 'mikka1820-exact-suggestion', applicationSha: SHA, headSha: 'b'.repeat(40),
          driverRunId: 123, driverAttempt: 1, window: { commentId: 4, markerSha256: 'd'.repeat(64) }, ownerHash: hash(options.recoveryForeignOwner ? 'other-owner' : OWNER),
          workspaceId: HOME, suggestionId: ITEM, originalWorkspaceId: HOME, selectedWorkspaceId: TEAM, sessionIdHash: hash(OLD_SESSION),
          priorSessionIdHashes: [], recoveryOf: null, nonce: NONCE, sourceUrl: SOURCE, occurredAt: sourceComment().created_at,
          action: 'reply', required: false, externalSourceClosed: true, sourceEventId: 91, sourceIssueNumber: 73,
          state: 'bound_before_mutation', observedAt: new Date(NOW - 30_000).toISOString() }) }
    },
    writeReceipt: async value => { if (options.receiptFailure) throw new Error(PASSWORD); receipts.push(structuredClone(value)) } }
  return { args, calls, receipts, mutations, history, sockets, state: () => ({ loggedIn, selected, snoozedUntil, rejectedAt, oldSessionPresent }) }
}

function noLeaks(report) {
  const text = JSON.stringify(report)
  for (const secret of [OWNER, EMAIL, PASSWORD, COOKIE, OLD_SESSION, OLD_TOKEN, OTHER_SESSION, 'private-session-canary', 'existing private title canary', 'private-branch-canary'])
    assert.equal(text.includes(secret), false, 'closed receipt must not contain ' + secret)
}

test('untrusted target fails before accessing credentials or network', async () => {
  let credentialsRead = false, requested = false
  const report = await runInboxProduction({ env: { get SMOKE_OWNER_EMAIL() { credentialsRead = true; return EMAIL } },
    assertTarget: async () => { throw new Error('untrusted') }, fetchImpl: async () => { requested = true } })
  assert.equal(report.status, 'failed'); assert.equal(credentialsRead, false); assert.equal(requested, false)
})

test('withdrawn release authority stops new business but finishes only the journaled cleanup, saved workspace and session', async () => {
  const f = fixture({ windowLost: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'inbox_window_invalid')
  assert.deepEqual(f.mutations, ['snooze', 'reopen', 'reject'], 'the duplicate business write is refused but exact owned cleanup remains authorized')
  assert.equal(report.cleanup.status, 'passed'); assert.equal(report.cleanup.originalCookieRejected, true)
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(report.cleanup.ownSuggestionDismissed, true)
  assert.equal(f.state().snoozedUntil, null); assert.ok(f.state().rejectedAt); assert.equal(f.state().selected, HOME)
  assert.equal(report.cleanup.liveClosed, true); assert.equal(f.receipts[0].state, 'bound_before_mutation')
  noLeaks(report)
})

test('recovery handles pending, snoozed and already rejected exact objects without new fixtures, suggestions wakeups or acceptance credit', async () => {
  for (const state of ['pending', 'snoozed', 'done']) {
    const f = fixture({ recovery: state, windowLost: true }), report = await runInboxProduction(f.args)
    assert.equal(report.status, 'cleanup_passed', JSON.stringify(report.failure ?? report.cleanup.failures))
    assert.equal(inboxProductionExitCode(report), 2, 'cleanup success cannot turn incomplete business acceptance green')
    assert.equal(report.completeAcceptance, false); assert.equal(report.recovery.priorState, state)
    assert.deepEqual(f.mutations, ['reopen', 'reject']); assert.equal(f.receipts[0].state, 'recovery_bound_before_cleanup')
    assert.deepEqual(f.receipts[0].priorSessionIdHashes, [hash(OLD_SESSION)])
    assert.equal(report.cleanup.originalSessionsRevoked, 1); assert.equal(f.state().oldSessionPresent, false)
    assert.equal(report.cleanup.workspaceRestored, true); assert.equal(f.state().selected, HOME)
    assert.equal(report.cleanup.originalCookieRejected, true); assert.equal(f.sockets.length, 0)
    assert.equal(f.calls.some(call => ['/api/suggestions', '/api/integrations/github', '/api/issues/search', '/api/live/ticket'].includes(call.path)), false)
    noLeaks(report); noLeaks(f.receipts)
  }
})

test('missing original proof rejects before sign-in; foreign ownership, missing object or unwritten new journal cannot authorize recovery writes', async () => {
  const absent = fixture({ recovery: 'snoozed', recoveryProofFailure: true }), first = await runInboxProduction(absent.args)
  assert.equal(first.failure.code, 'recovery_log_invalid'); assert.equal(absent.calls.some(call => call.path.startsWith('/api/auth/')), false)
  for (const options of [{ recoveryForeignOwner: true }, { recoveryMissing: true }, { receiptFailure: true }]) {
    const f = fixture({ recovery: 'snoozed', ...options }), report = await runInboxProduction(f.args)
    assert.equal(report.status, 'failed'); assert.equal(report.completeAcceptance, false); assert.equal(f.mutations.length, 0)
    assert.equal(f.calls.some(call => ['/api/rpc', '/api/auth/revoke-session'].includes(call.path)), false)
    assert.equal(report.cleanup.originalCookieRejected, true); noLeaks(report)
  }
})

test('original session absence is exact and a false revoke success cannot hide a remaining session', async () => {
  const absent = fixture({ recovery: 'done', originalSessionAbsent: true }), passed = await runInboxProduction(absent.args)
  assert.equal(passed.status, 'cleanup_passed'); assert.equal(passed.recovery.originalSessionsAbsent, 1)
  assert.equal(absent.calls.some(call => call.path === '/api/auth/revoke-session'), false)
  const present = fixture({ recovery: 'snoozed', ignoreOldSessionRevoke: true }), failed = await runInboxProduction(present.args)
  assert.equal(failed.status, 'failed'); assert.equal(failed.cleanup.status, 'failed')
  assert.equal(failed.cleanup.failures[0].step, 'original_sessions'); assert.equal(failed.cleanup.originalCookieRejected, true)
  noLeaks(passed); noLeaks(failed)
})

test('inventory reads real owner metadata without suggestions side effects or historical mutations', async () => {
  const f = fixture({ inventoryOnly: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'partial'); assert.equal(report.completeAcceptance, false); assert.equal(report.apiStatus, 'passed')
  assert.equal(inboxProductionExitCode(report), 2)
  assert.equal(report.coverage.cachedReviewSummary, 'handoff_complete_snapshot_readback'); assert.equal(report.coverage.noPrNull, 'normal_owner_flow_null')
  assert.equal(report.inventory.github.recipients[0].id, '42')
  assert.equal(f.calls.some(call => call.path === '/api/suggestions'), false); assert.equal(f.mutations.length, 0)
  assert.equal(report.cleanup.originalCookieRejected, true); assert.equal(report.cleanup.workspaceRestored, true)
  noLeaks(report)
})

test('Factory discovery follows selected-team issue pages and the sixth returned task without reading another accessible team', async () => {
  const f = fixture({ inventoryOnly: true, noGitHub: true, extendedFactory: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'partial', JSON.stringify(report.failure))
  assert.equal(report.coverage.cachedReviewSummary, 'handoff_complete_snapshot_readback')
  assert.equal(report.coverage.noPrNull, 'normal_owner_flow_null')
  assert.equal(report.inventory.factory.selectedWorkspaceId, TEAM)
  assert.deepEqual(report.inventory.factory.workspaces.map(row => row.workspaceId), [TEAM])
  assert.equal(report.inventory.factory.issuesRead, 2)
  assert.equal(report.inventory.factory.tasksRead, 7)
  assert.equal(report.inventory.factory.issuePaginationComplete, true)
  assert.equal(report.inventory.factory.returnedTaskReadsComplete, true)
  assert.equal(report.inventory.factory.complete, false)
  assert.equal(report.inventory.factory.taskCompleteness, 'unknown_server_limit_before_filter')
  assert.equal(f.calls.filter(call => call.path === '/api/issues/search').length, 2)
  assert.equal(f.calls.filter(call => call.path === '/api/factory/tasks/' + TASK_PR + '/flow').length, 2)
  for (const call of f.calls.filter(call => call.path.startsWith('/api/factory/tasks') || call.path === '/api/issues/search')) {
    assert.equal(call.workspaceHeader, TEAM)
    assert.equal(call.search.includes(OTHER_TEAM), false)
  }
  assert.equal(f.mutations.length, 0)
  assert.equal(f.calls.some(call => call.path === '/api/suggestions'), false)
  assert.equal(report.cleanup.originalCookieRejected, true)
  assert.equal(report.cleanup.workspaceRestored, true)
  noLeaks(report)
})

test('empty or short Factory responses never prove all tasks enumerated or absence of a PR', async () => {
  for (const noFactory of [true, false]) {
    const f = fixture({ inventoryOnly: true, noFactory }), report = await runInboxProduction(f.args)
    assert.equal(report.inventory.factory.complete, false)
    assert.equal(report.inventory.factory.taskCompleteness, 'unknown_server_limit_before_filter')
    assert.equal(report.inventory.factory.issuePaginationComplete, true)
    assert.equal(report.inventory.factory.returnedTaskReadsComplete, true)
    assert.equal(report.completeAcceptance, false)
    if (noFactory) assert.equal(report.coverage.cachedReviewSummary, 'not_observed')
  }
})

test('a repeating issue cursor cannot claim exhaustive discovery and still signs out the exact session', async () => {
  const f = fixture({ inventoryOnly: true, repeatIssueCursor: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed')
  assert.equal(report.failure.code, 'response_invalid')
  assert.equal(report.inventory.factory.complete, false)
  assert.equal(report.inventory.factory.issuePaginationComplete, false)
  assert.equal(report.cleanup.originalCookieRejected, true)
  noLeaks(report)
})

test('Factory discovery does not truncate the twenty-first issue and reports bounded live traversal separately', async () => {
  const issues = Array.from({ length: 21 }, (_, index) => '30000000-0000-4000-8000-' + String(index + 100).padStart(12, '0'))
  let listReads = 0
  const inventory = await readInboxFactoryInventory({ workspaceId: TEAM, request: async (_, path, init) => {
    assert.equal(init.headers['x-mikka-workspace-id'], TEAM)
    const url = new URL(path, 'https://example.invalid')
    if (url.pathname === '/api/issues/search') return { status: 200, body: { items: issues.map(id => ({ id })), nextCursor: null, truncated: false } }
    assert.equal(url.pathname, '/api/factory/tasks'); listReads++
    return { status: 200, body: { issueId: url.searchParams.get('issueId'), liveWorkspaceId: TEAM, tasks: [] } }
  } })
  assert.equal(listReads, 21); assert.equal(inventory.issuesRead, 21)
  assert.equal(inventory.issuePaginationComplete, true); assert.equal(inventory.returnedTaskReadsComplete, true)
  assert.equal(inventory.complete, false); assert.equal(inventory.taskCompleteness, 'unknown_server_limit_before_filter')
})

test('request and time bounds leave incomplete issue/task discovery explicit instead of claiming the account has no PR', async () => {
  for (const limit of ['requests', 'time']) {
    let clock = NOW, calls = 0
    const inventory = await readInboxFactoryInventory({ workspaceId: TEAM,
      now: () => clock, deadline: NOW + 1000, requestLimit: limit === 'requests' ? 1 : 400,
      request: async () => { calls++; clock += limit === 'time' ? 1001 : 0
        return { status: 200, body: { items: [{ id: ISSUE }], nextCursor: null, truncated: false } } },
    })
    assert.equal(calls, 1); assert.equal(inventory.complete, false)
    assert.equal(inventory.stopReason, limit === 'requests' ? 'request_limit' : 'time_limit')
    assert.equal(inventory.workspaces[0].visited, true); assert.equal(inventory.workspaces[0].issuesRead, 0)
    assert.equal(inventory.workspaces[0].stopReason, inventory.stopReason)
    assert.equal(inventory.issuePaginationComplete, false); assert.equal(inventory.returnedTaskReadsComplete, false)
  }
})

test('a Factory list returned for another live tenant cannot be read through or count as coverage', async () => {
  let flows = 0
  await assert.rejects(readInboxFactoryInventory({ workspaceId: TEAM, request: async (_, path) => {
    if (path.startsWith('/api/issues/search')) return { status: 200, body: { items: [{ id: ISSUE }], nextCursor: null, truncated: false } }
    if (path.startsWith('/api/factory/tasks?')) return { status: 200, body: { issueId: ISSUE, liveWorkspaceId: OTHER_TEAM, tasks: [{ id: TASK_PR }] } }
    flows++; assert.fail('foreign tenant flow')
  } }), /response_invalid/)
  assert.equal(flows, 0)
})

test('a withdrawn source/window between issue pages prevents the next page from being requested', async () => {
  let pages = 0, leases = 0
  await assert.rejects(readInboxFactoryInventory({ workspaceId: TEAM,
    beforePage: async () => { if (++leases === 2) throw new InboxSelectionError('inbox_window_invalid', 'marker') },
    request: async () => { pages++; return { status: 200, body: { items: [], nextCursor: 'next-page', truncated: false } } },
  }), /inbox_window_invalid/)
  assert.equal(pages, 1); assert.equal(leases, 2)
})

test('exact owned source runs transitions, duplicates, real push boundary and receipt readbacks, then cleans', async () => {
  const f = fixture(), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'passed', JSON.stringify(report.failure)); assert.equal(report.completeAcceptance, true)
  assert.equal(inboxProductionExitCode(report), 0)
  assert.equal(report.checks.suggestionsReadMayWriteBriefingAndTriggers, true)
  assert.equal(report.coverage.snoozeExpiryPush, 'due_timer_push_and_single_readback')
  assert.equal(report.cleanup.ownSuggestionDismissed, true); assert.equal(report.cleanup.immutableReceiptsRetained, 2)
  assert.equal(report.cleanup.externalSourceAlreadyClosed, true); assert.equal(f.history.length, 2)
  assert.deepEqual(f.receipts.map(row => row.state), ['bound_before_mutation', 'business_checks_passed', 'cleaned'])
  assert.equal(f.state().loggedIn, false); assert.equal(f.state().selected, HOME); assert.equal(f.state().snoozedUntil, null)
  assert.ok(f.state().rejectedAt); assert.ok(f.sockets.every(socket => socket.readyState === 3)); noLeaks(report)
})

test('source recipient cannot be substituted; missing existing GitHub authority does not create a connection', async () => {
  for (const options of [{ sourceOwner: true }, { noGitHub: true }]) {
    const f = fixture(options), report = await runInboxProduction(f.args)
    assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'fixture_binding_failed')
    assert.equal(f.calls.some(call => call.path === '/api/suggestions'), false); assert.equal(f.mutations.length, 0); noLeaks(report)
  }
})

test('the owner-only verified cloud identity binds a real recipient without a GitHub sign-in account or credential export', async () => {
  const f = fixture({ cloudIdentity: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'passed', JSON.stringify(report.failure))
  assert.deepEqual(report.inventory.github.recipients, [{ id: '42', source: 'verified_integration' }])
  assert.equal(report.inventory.github.source, 'cloud'); assert.equal(report.inventory.github.testRepositoryAuthorized, true)
  assert.equal(f.calls.some(call => call.path.startsWith('/users/')), false)
  noLeaks(report)
})

test('wrong exact URL or Decision suppression never falls back to another suggestion or title', async () => {
  for (const options of [{ wrongSourceUrl: true }, { noSuggestion: true }]) {
    const f = fixture(options), report = await runInboxProduction(f.args)
    assert.equal(report.failure.code, 'fixture_unavailable'); assert.equal(f.mutations.length, 0); noLeaks(report)
  }
})

test('unknown cached checks are not zero or green; missing Factory fixtures remain explicit', async () => {
  for (const options of [{ unknownChecks: true }, { noFactory: true }, { changedReadback: true }]) {
    const f = fixture({ ...options, inventoryOnly: true }), report = await runInboxProduction(f.args)
    assert.equal(report.status, 'partial'); assert.equal(report.coverage.cachedReviewSummary, 'not_observed')
    assert.equal(report.completeAcceptance, false); noLeaks(report)
  }
  const f = fixture({ inventoryOnly: true, nonNullNoPr: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'response_invalid')
})

test('follow-up receipts name actual release 1856 and keep original-source fixtures out of new-source business', async () => {
  const inventory = fixture({ followup: true, inventoryOnly: true }), observed = await runInboxProduction(inventory.args)
  assert.equal(observed.status, 'partial'); assert.equal(observed.selection.pr, 1856); assert.equal(observed.selection.featurePr, 1822)
  assert.equal(observed.selection.originMergeSha, INBOX_ORIGINAL_MERGE); assert.equal(inventory.mutations.length, 0)
  assert.equal(observed.cleanup.originalCookieRejected, true); noLeaks(observed)
  const old = fixture({ followup: true, oldFollowupFixture: true }), rejected = await runInboxProduction(old.args)
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.failure.code, 'fixture_binding_failed')
  assert.equal(old.mutations.length, 0); assert.equal(old.calls.some(call => call.path === '/api/suggestions'), false)
  assert.equal(rejected.cleanup.originalCookieRejected, true); noLeaks(rejected)
})

test('withdrawn follow-up authority still allows only that attempt journal cleanup and session logout', async () => {
  const f = fixture({ followup: true, windowLost: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'inbox_window_invalid')
  assert.equal(report.selection.pr, 1856); assert.equal(report.completeAcceptance, false)
  assert.deepEqual(f.mutations, ['snooze', 'reopen', 'reject'])
  assert.equal(report.cleanup.ownSuggestionDismissed, true); assert.equal(report.cleanup.originalCookieRejected, true)
  assert.equal(report.cleanup.workspaceRestored, true); noLeaks(report)
})

test('lost accepted write uses only the journaled UUID for normal idempotent cleanup', async () => {
  const f = fixture({ lostWrite: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'request_failed')
  assert.equal(report.cleanup.ownSuggestionDismissed, true); assert.equal(f.state().snoozedUntil, null)
  assert.deepEqual(f.mutations, ['snooze', 'reopen', 'reject']); assert.equal(f.receipts[0].state, 'bound_before_mutation'); noLeaks(report)
})

test('a failed durable binding receipt refuses all inbox writes', async () => {
  const f = fixture({ receiptFailure: true }), report = await runInboxProduction(f.args)
  assert.equal(report.failure.code, 'receipt_failed'); assert.equal(f.mutations.length, 0)
  assert.equal(report.cleanup.originalCookieRejected, true); noLeaks(report)
})

test('duplicate completion or cleanup refusal cannot produce a passed acceptance', async () => {
  const duplicate = fixture({ duplicateReceipts: true }), duplicateReport = await runInboxProduction(duplicate.args)
  assert.equal(duplicateReport.status, 'failed'); assert.equal(duplicateReport.failure.code, 'receipt_mismatch')
  const f = fixture({ cleanupFailure: true }), report = await runInboxProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.status, 'failed')
  assert.deepEqual(report.cleanup.failures[0], { step: 'own_suggestion', code: 'unexpected_status', httpStatus: 500, body: { errorCode: 'inboxConflict' } })
  assert.equal(report.cleanup.originalCookieRejected, true); noLeaks(report)
})

test('logout and closing production version are independently checked', async () => {
  for (const options of [{ ignoreLogout: true }, { changedClosingBuild: true }]) {
    const f = fixture({ ...options, inventoryOnly: true }), report = await runInboxProduction(f.args)
    assert.equal(report.status, 'failed'); assert.ok(report.cleanup.failures.length); noLeaks(report)
  }
})

test('fixture requires fresh nonce, exact public source, owner and personal scope before any application write', async () => {
  const valid = fixtureManifest(), source = { ownerId: OWNER, personalWorkspaceId: HOME, applicationSha: SHA, driverRunId: 123, driverRunAttempt: 1, recipientIds: new Set(['42']), now: () => NOW,
    githubRead: async path => path.endsWith('/issues/73') ? sourceIssue() : sourceComment() }
  assert.equal((await verifyInboxFixture(valid, source)).sourceEventId, 91)
  for (const patch of [{ ownerHash: hash('other') }, { workspaceId: TEAM }, { applicationSha: 'd'.repeat(40) },
    { inventoryRunId: 999 }, { inventoryRunAttempt: 2 }, { expiresAt: new Date(NOW - 1).toISOString() },
    { github: { ...valid.github, repository: 'someone/real-repository' } }, { nonce: ISSUE }])
    await assert.rejects(verifyInboxFixture({ ...valid, ...patch }, source), /fixture_(binding_failed|expired)/)
  await assert.rejects(verifyInboxFixture(valid, { ...source, githubRead: async path => path.endsWith('/issues/73') ? { ...sourceIssue(), state: 'open' } : sourceComment() }), /fixture_binding_failed/)
  const milliseconds = { ...valid, createdAt: new Date(Date.parse(valid.createdAt) + 123).toISOString() }
  const normalized = await verifyInboxFixture(milliseconds, { ...source, githubRead: async path => path.endsWith('/issues/73')
    ? { ...sourceIssue(), created_at: sourceIssue().created_at.replace('.000Z', 'Z') }
    : { ...sourceComment(), created_at: sourceComment().created_at.replace('.000Z', 'Z') } })
  assert.equal(normalized.occurredAt, sourceComment().created_at, 'GitHub second precision and JSON ISO milliseconds identify the same event')
})

test('the existing socket heartbeat keeps the channel live without an HTTP read', async () => {
  const expiresAt = NOW + 300_000, channel = hash(JSON.stringify([OWNER, HOME]))
  let pings = 0
  const socket = new Socket()
  socket.send = value => {
    assert.equal(value, 'ping'); pings++
    socket.dispatchEvent(new MessageEvent('message', { data: 'pong' }))
    for (const kind of ['issue_list', 'pending_actions']) socket.frame({ kind, id: HOME })
  }
  const live = inboxLiveSocket({ url: 'wss://mikka-gateway.aspectlylabs.com/v1/live/' + channel + '/socket',
    protocol: 'mikka-ticket-' + expiresAt / 1000 + '-' + 'c'.repeat(64), expiresAt },
  { ownerId: OWNER, workspaceId: HOME, now: () => NOW, socketFactory: () => socket, heartbeatMs: 2, timeoutMs: 500 })
  try { await live.ready(); await live.expect()(); assert.ok(pings > 0) }
  finally { await live.close() }
  assert.equal(socket.readyState, 3)
})

test('foreign live workspace, gateway, arbitrary protocol or expiry never reaches a socket', () => {
  const expiresAt = NOW + 300_000, value = { url: 'wss://mikka-gateway.aspectlylabs.com/v1/live/' + hash(JSON.stringify([OWNER, HOME])) + '/socket',
    protocol: 'mikka-ticket-' + expiresAt / 1000 + '-' + 'a'.repeat(64), expiresAt }
  const options = { ownerId: OWNER, workspaceId: HOME, now: () => NOW, socketFactory: () => assert.fail('untrusted socket') }
  for (const patch of [{ url: value.url.replace('mikka-gateway.aspectlylabs.com', 'other.invalid') }, { url: value.url + '?token=secret' },
    { url: value.url.replace(hash(JSON.stringify([OWNER, HOME])), hash(JSON.stringify([OWNER, TEAM]))) }, { protocol: COOKIE }, { expiresAt: NOW }])
    assert.throws(() => inboxLiveSocket({ ...value, ...patch }, options), /live_invalid/)
})

test('workflow keeps the existing current-main queue and two narrow Infisical secrets', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8')
  assert.equal((workflow.match(/identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/g) ?? []).length, 2)
  assert.deepEqual([...workflow.matchAll(/secret-name: (.+)/g)].map(match => match[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  assert.match(workflow, /production-smoke-owner-acceptance/); assert.match(workflow, /scripts\/acceptance\/inbox-production\.mjs/)
  assert.match(workflow, /pull-requests: read/)
  assert.match(workflow, /scripts\/acceptance\/self-hosted-production\*\.mjs/)
  assert.match(workflow, /run: node --import tsx --test[^\n]*scripts\/acceptance\/inbox-production-target\.test\.mjs/)
  assert.equal((workflow.match(/name: Verify the exact Inbox fixture or inventory under its current release window/g) ?? []).length, 1)
  assert.ok(workflow.indexOf('inbox-production.mjs --select') < workflow.indexOf('uses: Infisical/secrets-action'))
  assert.match(workflow, /if: steps\.inbox_selection\.outputs\.selected == 'true'/)
  assert.doesNotMatch(workflow, /workflow_dispatch:|contents: write|actions: write|continue-on-error: true[\s\S]{0,180}inbox-production\.mjs/)
})
