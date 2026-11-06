import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { CLEANUP_SCOPE, cleanupFinalWorkspace, cleanupGroups, cleanupInventory, loadCleanupEvidence, validateCleanupEvidence, verifyFinalDeletion } from './final-cleanup.mjs'
import { groupName } from './group-stop.mjs'
import { ref } from './workspace-setup.mjs'
import { fixtureName } from './coordinator-fixtures.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const PRIVATE = 'PRIVATE_CANARY_DO_NOT_REPORT', SHA = 'b'.repeat(40), hash = value => createHash('sha256').update(value).digest('hex')
const fixtures = JSON.parse(readFileSync(new URL('./receipts/fixtures-ready-42286389783.json', import.meta.url), 'utf8'))
const keys = ['public-haiku', 'public-luna', 'private-haiku', 'private-luna']
const id = (prefix, index) => `${prefix}0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`

function evidence() {
  const cases = keys.map((key, index) => {
    const [scenario, fixtureKey] = key.split('-'), groupId = id('1', index), messageId = id('2', index), isPrivate = scenario === 'private'
    const linkId = id('3', index), privateId = id('4', index), count = isPrivate ? 2 : 1
    const group = { schemaVersion: 1, issue: 1506, phase: 'alex-group-stop', ownerRef: ref(ALEX_OWNER_ID), workspaceId: CLEANUP_SCOPE.workspaceId,
      fixtureRunKey: CLEANUP_SCOPE.runKey, fixtureKey, scenario, boundary: isPrivate ? 'private_generation_receipt' : 'responding_bot',
      applicationSha: SHA, groupId, messageId, mode: 'observe', status: 'stop_evidence_captured', signedOut: true,
      createAttempted: true, messageSendAttempts: 1, sentAt: '2026-11-06T22:00:00.000Z',
      stop: { requested: true, acknowledged: true, stoppedTurns: 1 }, afterStop: { botReplyCount: 0 },
      cleanup: { hidden: false, retainedBotIds: [...CLEANUP_SCOPE.botIds], removedBotIds: [] },
      turn: { publicPublishes: 0, privatePublishes: isPrivate ? 1 : 0 },
      ...(isPrivate ? { privateBoundary: { linkId, privateMessagesBeforeStop: 1, targetGenerateRecorded: true,
        targetBotId: fixtures.fixtures.find(row => row.key === fixtureKey).botId } } : {}) }
    const terminal = { schemaVersion: 1, issue: 1506, applicationSha: SHA, source: 'vercel_runtime_logs', capturedAt: '2026-11-06T22:00:06.000Z',
      records: [{ event: 'group_turn_terminal', conversationId: groupId, messageId, started: count, settled: count, aborted: 1,
        sessionLost: false, endedAt: Date.parse('2026-11-06T22:00:05.000Z') }] }
    const facts = { schemaVersion: 1, issue: 1506, scopeMatched: true, observedAt: '2026-11-06T22:00:08.000Z',
      scope: { groupId, messageId, workspaceId: CLEANUP_SCOPE.workspaceId, ownerMatches: true, rootPosition: '1' },
      membership: { intact: true, total: 3, active: 3, activeExpectedOwner: 1, activeExpectedBots: 2, unexpectedMembers: 0, departed: 0 },
      turn: { status: 'failed', isStopped: true, hasOtherError: false, agentActive: false, botActive: false, activeRunId: null,
        nextDecisionAt: null, traceStatus: 'stopped', traceEventsArray: true }, cancellationFeedbackCount: 1,
      activeSession: { source: 'exact_group_advisory_lock', locks: 0, held: 0, waiters: 0, rowsTruncated: false },
      public: { replyCount: 0, totalGroupMessages: 1, otherUserRoots: 0, unexpectedAuthors: 0, rowsTruncated: false, rows: [] },
      private: { foreignScopeLinks: 0, invalidMemberships: 0, otherAnchorLinks: 0, unexpectedAuthors: 0, linksTruncated: false,
        rowsTruncated: false, linkCount: isPrivate ? 1 : 0, declaredMessages: isPrivate ? 1 : 0, actualMessages: isPrivate ? 1 : 0,
        rows: isPrivate ? [{ linkId, id: id('5', index), position: '1' }] : [],
        links: isPrivate ? [{ id: linkId, privateConversationId: privateId, ownedScope: true, messageCount: 1 }] : [] },
      trace: { generateCount: count, publicPublishCount: 0, privatePublishCount: isPrivate ? 1 : 0, delegateCount: 0,
        taskEventCount: 0, unknownEvents: 0, eventsTruncated: false },
      delegation: { bindings: 0, receipts: 0, foreignOwnerBindings: 0, foreignOwnerReceipts: 0, entriesTruncated: false } }
    const terminalHash = hash(JSON.stringify(terminal))
    const audit = { schemaVersion: 1, issue: 1506, applicationSha: SHA, statementSha256: CLEANUP_SCOPE.auditStatementSha256,
      terminalReceiptSha256: terminalHash, executedOnce: true, startedAt: '2026-11-06T22:00:07.000Z', audit: facts }
    return { key, group, terminal, audit, hashes: { group: hash(JSON.stringify(group)), terminal: terminalHash, audit: hash(JSON.stringify(audit)) } }
  })
  return { manifest: { schemaVersion: 1, issue: 1506, phase: 'alex-final-cleanup-evidence', applicationSha: SHA, allCasesCompleted: true },
    manifestSha256: 'a'.repeat(64), fixtures: structuredClone(fixtures), cases }
}

function sessionFixture(input, { extraGroup = false, extraMember = false, wrongBot = false, busy = false,
  lostRemoval = false, failedRemoval = false, lostHide = false, extraTask = false, lostDelete = false } = {}) {
  const state = { requests: [], sessions: 0, signouts: 0, removed: [], groupHides: [], botHides: [], deletes: 0, deleted: false, stops: 0, messages: 0 }
  const members = new Map(input.cases.map(row => [row.group.groupId, [...CLEANUP_SCOPE.botIds]]))
  let selected = false, removalLost = false, hideLost = false
  const provider = async (work, options) => {
    assert.equal(options.expectedSha, null); state.sessions++
    try {
      return await work({ identity: { userId: ALEX_OWNER_ID }, version: { build: SHA }, requests: state.requests,
        async request(path, request = {}) {
          const route = path.split('?')[0], method = request.method ?? (request.body ? 'POST' : 'GET')
          let result
          if (route === '/api/workspace/switcher') result = { workspace: { id: selected ? CLEANUP_SCOPE.workspaceId : '4ae2a643-b09e-43eb-816c-1e5557bef170' },
            accounts: [{ id: ALEX_OWNER_ID, email: PRIVATE, choices: [{ id: '4ae2a643-b09e-43eb-816c-1e5557bef170', kind: 'personal', name: PRIVATE },
              ...(!state.deleted ? [{ id: CLEANUP_SCOPE.workspaceId, kind: 'team', name: fixtures.workspace.name }] : [])] }] }
          else if (route === '/api/workspace') {
            assert.equal(path, '/api/workspace?workspace=' + CLEANUP_SCOPE.workspaceId)
            result = { workspace: fixtures.workspace, currentUserId: ALEX_OWNER_ID, role: 'admin',
              members: [{ userId: ALEX_OWNER_ID, role: 'admin', status: 'active', name: PRIVATE }], invitations: [] }
          } else if (route === '/api/bots') {
            assert.equal(method, 'GET')
            result = fixtures.fixtures.map(row => ({ id: row.botId, ownerId: wrongBot ? PRIVATE : ALEX_OWNER_ID,
              workspaceId: CLEANUP_SCOPE.workspaceId, name: fixtureName(CLEANUP_SCOPE.runKey, row.key) }))
          } else if (route === '/api/conversations') {
            assert.equal(path, '/api/conversations?workspaceId=' + CLEANUP_SCOPE.workspaceId); assert.equal(method, 'GET')
            result = { viewerId: ALEX_OWNER_ID, workspaceId: CLEANUP_SCOPE.workspaceId,
              conversations: [...input.cases.map(row => ({ id: row.group.groupId, kind: 'group', createdBy: ALEX_OWNER_ID,
                workspaceId: CLEANUP_SCOPE.workspaceId, title: groupName(row.group), lastMessage: PRIVATE })),
              ...(extraGroup ? [{ id: id('9', 0), kind: 'group', createdBy: ALEX_OWNER_ID, workspaceId: CLEANUP_SCOPE.workspaceId, title: PRIVATE }] : [])] }
          } else if (route.startsWith('/api/conversations/')) {
            const [, , groupId, operation] = route.split('/').slice(1)
            const row = input.cases.find(item => item.group.groupId === groupId)
            assert.ok(row, 'only a pinned group is reachable')
            if (operation === 'members') {
              if (method === 'DELETE') {
                assert.equal(request.body.memberType, 'bot'); assert.ok(CLEANUP_SCOPE.botIds.includes(request.body.memberId))
                state.removed.push([groupId, request.body.memberId])
                if (!failedRemoval) members.set(groupId, members.get(groupId).filter(id => id !== request.body.memberId))
                if (lostRemoval && !removalLost) { removalLost = true; throw new Error(PRIVATE) }
                result = failedRemoval ? { ok: false } : { ok: true }
              } else result = { members: [{ id: ALEX_OWNER_ID, memberType: 'user', role: 'owner', name: PRIVATE },
                ...members.get(groupId).map(id => ({ id, memberType: 'bot', role: 'member', name: PRIVATE })),
                ...(extraMember ? [{ id: PRIVATE, memberType: 'user', role: 'member' }] : [])] }
            } else if (operation === 'messages') {
              assert.equal(method, 'GET', 'cleanup must never send a message')
              result = { agentStatus: null, stopped: true, messages: [{ id: row.group.messageId, authorType: 'user', authorId: ALEX_OWNER_ID, body: PRIVATE }],
                timeline: row.audit.audit.private.links.map(link => ({ type: 'agent_exchange', linkId: link.id, anchorPosition: '1', count: '1', private: PRIVATE })) }
            } else assert.fail('no Stop or unrelated group action during cleanup')
          } else if (route.startsWith('/api/mobile/groups/')) {
            const groupId = route.split('/').at(-1); assert.ok(members.has(groupId)); assert.equal(members.get(groupId).length, 0)
            assert.equal(method, 'PATCH'); assert.deepEqual(request.body, { hidden: true }); state.groupHides.push(groupId)
            if (lostHide && !hideLost) { hideLost = true; throw new Error(PRIVATE) }
            result = { ok: true }
          } else if (route.startsWith('/api/mobile/bots/')) {
            const botId = route.split('/').at(-1); assert.ok(CLEANUP_SCOPE.botIds.includes(botId)); assert.equal(method, 'PATCH')
            assert.deepEqual(request.body, { hidden: true }); state.botHides.push(botId); result = { ok: true }
          } else if (route === '/api/rpc') {
            const { action, args } = request.body
            if (action === 'workspace.switchWorkspace') { assert.deepEqual(args, [CLEANUP_SCOPE.workspaceId]); selected = true; result = { ok: true, data: { workspaceId: CLEANUP_SCOPE.workspaceId } } }
            else if (action === 'workspace-settings.getWorkspaceGeneral') result = { ...fixtures.workspace, personal: false, canEdit: true, canTransfer: true }
            else if (action === 'coordinator.syncCoordinatorChat') {
              assert.ok(CLEANUP_SCOPE.botIds.includes(args[0]))
              result = { chat: { botId: args[0], working: busy, enabled: true, ...(busy ? { streamRunId: 'wrun_private' } : {}), items: [{ text: PRIVATE }] } }
            } else if (action === 'workspace-settings.getWorkspaceDeletionImpact') {
              assert.deepEqual(args, [CLEANUP_SCOPE.workspaceId]); result = { bots: 2, tasks: extraTask ? 1 : 0, teams: 0, purchasedPoints: 0 }
            } else if (action === 'workspace-settings.deleteWorkspace') {
              assert.deepEqual(args, [CLEANUP_SCOPE.workspaceId, fixtures.workspace.name]); state.deletes++; assert.equal(state.deletes, 1)
              assert.equal(state.groupHides.length, 4); assert.equal(state.botHides.length, 2)
              state.deleted = true
              if (lostDelete) throw new Error(PRIVATE)
              result = { deleted: { bots: 2, threads: 0, tasks: 0, projects: 0, teams: 0, invitations: 0, members: 1 } }
            } else assert.fail('unsafe RPC: ' + action)
            result = { ok: true, result }
          } else assert.fail('unexpected path: ' + path)
          state.requests.push({ path: '/mikka' + route, method, status: 200, headersMs: 0, private: PRIVATE })
          return Response.json(result)
        } })
    } finally { state.signouts++; state.requests.push({ path: '/mikka/api/auth/sign-out', method: 'POST', status: 200, headersMs: 0 }) }
  }
  return { state, members, provider }
}

test('all four exact host-terminal/audit cases validate before any cleanup authority exists', () => {
  const e = evidence(); assert.equal(validateCleanupEvidence(e), e)
  const resources = cleanupInventory(e)
  assert.equal(resources.groupCount, 4); assert.deepEqual(resources.botIds, CLEANUP_SCOPE.botIds)
  assert.equal(resources.groups.flatMap(row => row.privateConversationIds).length, 2)
})

test('missing terminal, unsettled generation, session loss, early audit and late side effects all block before login', async () => {
  for (const change of [
    e => { e.cases[0].terminal.records = [] }, e => { e.cases[0].terminal.records[0].settled = 0 },
    e => { e.cases[0].terminal.records[0].sessionLost = true }, e => { e.cases[0].audit.startedAt = '2026-11-06T22:00:03Z' },
    e => { e.cases[0].audit.audit.public.replyCount = 1 }, e => { e.cases[2].audit.audit.private.actualMessages = 2 },
    e => { e.cases[0].audit.audit.delegation.bindings = 1 }, e => { e.cases[0].audit.audit.activeSession.held = 1 },
    e => { e.cases[0].audit.audit.membership.departed = 1 }, e => { e.cases[0].audit.terminalReceiptSha256 = 'f'.repeat(64) },
  ]) {
    const e = evidence(); change(e); let sessions = 0
    await assert.rejects(cleanupGroups(e, { checkpoint: false, sessionProvider: () => { sessions++; throw new Error('must not log in') } }))
    assert.equal(sessions, 0)
  }
})

test('wrong owner/team/bots, duplicate cases and a mixed build never reach a normal API', () => {
  for (const change of [e => { e.fixtures.workspace.id = '4ae2a643-b09e-43eb-816c-1e5557bef170' },
    e => { e.fixtures.ownerRef = 'wrong' }, e => { e.fixtures.fixtures[0].botId = id('9', 4) },
    e => { e.cases[1] = structuredClone(e.cases[0]) }, e => { e.cases[0].group.applicationSha = 'c'.repeat(40) }]) {
    const e = evidence(); change(e); assert.throws(() => validateCleanupEvidence(e))
  }
})

test('normal cleanup removes exactly eight bot memberships and hides four own groups without Stop or model work', async () => {
  const e = evidence(), f = sessionFixture(e), result = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(result.signedOut, true)
  assert.equal(f.state.removed.length, 8); assert.equal(f.state.groupHides.length, 4); assert.equal(f.state.botHides.length, 0)
  assert.equal(f.state.deletes, 0); assert.equal(result.stopRequests, 0); assert.equal(result.modelCalls, 0)
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
  assert.equal(f.state.requests.filter(row => row.path.endsWith('/members') && row.method === 'GET').length, 8)
})

test('a foreign resource or membership blocks the whole preflight before the first cleanup write', async () => {
  for (const flags of [{ extraGroup: true }, { extraMember: true }, { wrongBot: true }]) {
    const e = evidence(), f = sessionFixture(e, flags), result = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
    assert.equal(result.status, 'failed'); assert.equal(f.state.removed.length, 0); assert.equal(f.state.groupHides.length, 0); assert.equal(f.state.signouts, 1)
  }
})

test('a lost removal acknowledgement is resolved by the one final member read without a write retry', async () => {
  const e = evidence(), f = sessionFixture(e, { lostRemoval: true }), result = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(result.status, 'complete', JSON.stringify(result)); assert.equal(f.state.removed.length, 8)
  assert.equal(result.groups[0].lastRemovalAcknowledgement, 'unknown_no_retry')
})

test('unconfirmed removal or hide retains a progress receipt and blocks final workspace deletion', async () => {
  for (const flags of [{ failedRemoval: true }, { lostHide: true }]) {
    const e = evidence(), f = sessionFixture(e, flags), result = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
    assert.equal(result.status, 'needs_followup'); const before = f.state.sessions
    await assert.rejects(cleanupFinalWorkspace(e, result, { sessionProvider: f.provider, checkpoint: false }), /cleanup_groups_incomplete/)
    assert.equal(f.state.sessions, before); assert.equal(f.state.botHides.length, 0); assert.equal(f.state.deletes, 0)
  }
})

test('an explicit resume retries only the unconfirmed group hide and never re-removes absent members', async () => {
  const e = evidence(), f = sessionFixture(e, { lostHide: true })
  const first = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(first.status, 'needs_followup')
  first.groups[0].untrusted = PRIVATE
  const next = await cleanupGroups(e, { previous: first, sessionProvider: f.provider, checkpoint: false })
  assert.equal(next.status, 'complete', JSON.stringify(next)); assert.equal(f.state.removed.length, 8); assert.equal(f.state.groupHides.length, 5)
  assert.equal(JSON.stringify(next).includes(PRIVATE), false)
})

test('all case completion, idle bots and zero task impact are required before bot hiding or workspace deletion', async () => {
  for (const flags of [{ busy: true }, { extraTask: true }, { unfinished: true }]) {
    const e = evidence(), f = sessionFixture(e, flags), groups = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
    if (flags.unfinished) {
      e.manifest.allCasesCompleted = false
      await assert.rejects(cleanupFinalWorkspace(e, groups, { sessionProvider: f.provider, checkpoint: false }), /cleanup_cases_unfinished/)
    } else {
      const result = await cleanupFinalWorkspace(e, groups, { sessionProvider: f.provider, checkpoint: false })
      assert.equal(result.status, 'failed'); assert.ok(['cleanup_bot_active', 'cleanup_impact_mismatch'].includes(result.error), JSON.stringify(result))
    }
    assert.equal(f.state.botHides.length, 0); assert.equal(f.state.deletes, 0)
  }
})

test('the existing normal delete helper receives four cleaned receipts only after both bots are hidden', async () => {
  const e = evidence(), f = sessionFixture(e), groups = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  const result = await cleanupFinalWorkspace(e, groups, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(result.status, 'deleted', JSON.stringify(result)); assert.equal(result.deletion.deleteAttempts, 1)
  assert.equal(f.state.deletes, 1); assert.deepEqual(f.state.botHides, CLEANUP_SCOPE.botIds)
  assert.equal(result.deletion.absentFromOwnerWorkspaceChoices, true)
  assert.equal(JSON.stringify(result).includes(PRIVATE), false)
})

test('lost workspace deletion acknowledgement does one absence read and never repeats delete', async () => {
  const e = evidence(), f = sessionFixture(e, { lostDelete: true }), groups = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  const result = await cleanupFinalWorkspace(e, groups, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(result.status, 'deleted', JSON.stringify(result)); assert.equal(f.state.deletes, 1)
  assert.equal(result.deletion.deleteAcknowledgement, 'absent_after_unknown_no_retry')
})

test('independent verification after an uncertain delete only reads absence and cannot repeat the write', async () => {
  const e = evidence(), f = sessionFixture(e), groups = await cleanupGroups(e, { sessionProvider: f.provider, checkpoint: false })
  const deleted = await cleanupFinalWorkspace(e, groups, { sessionProvider: f.provider, checkpoint: false })
  deleted.status = 'failed'; deleted.error = 'cleanup_delete_pending'
  const before = f.state.requests.length, result = await verifyFinalDeletion(e, deleted, { sessionProvider: f.provider, checkpoint: false })
  assert.equal(result.status, 'deleted', JSON.stringify(result)); assert.equal(result.deleteAttempts, 0); assert.equal(result.absenceReads, 1)
  assert.equal(f.state.deletes, 1)
  assert.deepEqual(f.state.requests.slice(before).map(row => [row.path, row.method]), [
    ['/mikka/api/workspace/switcher', 'GET'], ['/mikka/api/auth/sign-out', 'POST'],
  ])
  const invalid = structuredClone(deleted); invalid.deletion.deleteAttempts = 0
  await assert.rejects(verifyFinalDeletion(e, invalid, { sessionProvider: f.provider, checkpoint: false }), /cleanup_progress_invalid/)
})

test('CLI receipt loader verifies each raw hash and refuses path traversal before any session', () => {
  const directory = mkdtempSync(join(tmpdir(), 'group-cleanup-evidence-'))
  try {
    mkdirSync(join(directory, 'receipts'))
    const e = evidence(), descriptor = (name, value) => {
      const raw = JSON.stringify(value), path = `receipts/${name}.json`
      writeFileSync(join(directory, path), raw); return { path, sha256: hash(raw) }
    }
    const manifest = { ...e.manifest, fixtureReceipt: descriptor('fixtures', e.fixtures), cases: e.cases.map(row => ({ key: row.key,
      groupReceipt: descriptor(row.key + '-group', row.group), terminalReceipt: descriptor(row.key + '-terminal', row.terminal), auditReceipt: descriptor(row.key + '-audit', row.audit) })) }
    const path = join(directory, 'cleanup.json'); writeFileSync(path, JSON.stringify(manifest))
    assert.equal(loadCleanupEvidence(path).cases.length, 4)
    writeFileSync(join(directory, manifest.cases[0].groupReceipt.path), '{}')
    assert.throws(() => loadCleanupEvidence(path), /cleanup_receipt_hash_mismatch/)
    manifest.fixtureReceipt.path = '../private.json'; writeFileSync(path, JSON.stringify(manifest))
    assert.throws(() => loadCleanupEvidence(path), /cleanup_input_invalid/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
