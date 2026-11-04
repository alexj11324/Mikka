import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runAcceptanceBundle, sanitizeGroupReport, sanitizeReplayReport, sanitizeOwnerMcpReport, measureReplayEvidence, writeSanitizedReport } from './run-proactive-acceptance.mjs'

const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const env = { GROUP_ACCEPTANCE_DEPLOYMENT: 'dpl_fixture', GROUP_ACCEPTANCE_REVISION: 'a'.repeat(40),
  SMOKE_OWNER_EMAIL: 'alexjiang20232024+mikka-smoke-owner@gmail.com', SMOKE_OWNER_PASSWORD: 'synthetic-password-only',
  DEEPSEEK_API_KEY: 'synthetic-deepseek-only', E2B_API_KEY: 'synthetic-cloud-only' }
const receipt = { executionId: 'synthetic-execution', providerGenerationId: 'synthetic-generation', modelId: 'openai/gpt-6-luna-decisions',
  requestDigest: 'a'.repeat(64), startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:00.100Z', imageDigests: [], vision: 'no-image-input' }
const replayContract = { caseIds: Array.from({ length: 12 }, (_, i) => `case-${i}`), datasetDigest: 'b'.repeat(64),
  baselinePolicy: 'group-route-v0', candidatePolicy: 'group-contribution-v1' }
const replay = () => {
  let serial = 100
  const rows = (policyVersion, count) => replayContract.caseIds.map(caseId => {
    const decisions = Array.from({ length: count }, (_, index) => {
      serial++
      return { id: id(serial), phase: count === 2 && index === 0 ? 'intent' : 'responder', index, status: 'complete', failure: null,
        receipt: { ...receipt, executionId: `execution-${serial}`, providerGenerationId: `generation-${serial}` }, decisionCostUsd: null }
    })
    return { schemaVersion: 1, caseId, policyVersion, datasetDigest: replayContract.datasetDigest, inputDigest: 'c'.repeat(64),
      evidenceKind: 'actual-decision-inference', status: 'complete', receipt: decisions[0].receipt, decisionProtocol: 'group-sequential-v1',
      decisions, failureReason: null, decisionCalls: { attempted: count, receipted: count, unreceipted: 0 },
      decisionCost: { knownUsd: 0, knownCalls: 0, unknownCalls: count, omittedCalls: 0 }, decisionCostUsd: null,
      costScope: 'routing-decision-chain', executionPerformed: false, policyChanged: false }
  })
  return { status: 'complete', baseline: rows(replayContract.baselinePolicy, 1), candidate: rows(replayContract.candidatePolicy, 2),
    comparison: { decisionReviewReady: true } }
}

function fixture({ groupFails = true, throwsAfterCreation = false, replayFails = false, withTask = false, wrongTaskOwner = false,
  mcpShareFails = false, mcpCleanupFails = false, mcpCreateThrows = false, driftAfterMcp = false,
  helperLogoutStatus = 200, groupLogoutStatus = 200, unknownStop = false, wrongGroupOwner = false, sourceStopUnknown = false,
  mutateReplay = value => value, wrongRunOwner = false, runStatus = 'stopped', machineEndStatus = 200, unknownMachineEnd = false,
  terminalAfterMs = null, taskEpochChangesAfterMs = null } = {}) {
  const calls = [], counters = { helper: 0, group: 0, replay: 0, signout: 0, cancel: 0, mcpCreate: 0, mcpDelete: 0, groupStop: 0, machineEnd: 0 }
  let helperActive = false, mcpServer = null, createdGroup = null, stopped = false, taskCancelled = !groupFails, elapsed = 0
  const createdBots = [], fixtureId = id(700), marker = fixtureId.slice(0, 8)
  const existingMcp = { id: id(90), name: 'PRIVATE existing MCP', url: 'https://private.invalid', ownerId: 'fixture-owner', mine: true,
    shared: false, enabled: true, transport: 'http', authKind: 'header', revision: 1 }
  const mcpPage = () => ({ workspaceId: id(1), workspaceKind: 'personal', canShare: false,
    count: mcpServer ? 2 : 1, servers: [existingMcp, ...(mcpServer ? [mcpServer] : [])] })
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method })
    assert.equal(init.redirect, 'error')
    if (path.endsWith('/api/version')) return Response.json({ build: driftAfterMcp && counters.mcpDelete ? 'dpl_changed' : env.GROUP_ACCEPTANCE_DEPLOYMENT })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic-test-session=value; HttpOnly' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { id: 'fixture-owner', email: env.SMOKE_OWNER_EMAIL }, session: { userId: 'fixture-owner', token: 'PRIVATE_SESSION_TOKEN' } })
    if (path.endsWith('/api/bots')) {
      if (init.method !== 'POST') return Response.json([{ id: id(91), workspaceId: id(1), ownerId: 'fixture-owner' }, ...createdBots])
      const bot = { ...JSON.parse(init.body), id: id(10 + createdBots.length), ownerId: 'fixture-owner', workspaceId: id(1) }
      createdBots.push(bot); return Response.json(bot, { status: 201 })
    }
    if (path.endsWith('/api/workspace')) return Response.json({ currentUserId: 'fixture-owner', workspace: { id: id(1), kind: 'personal' }, role: 'admin', members: [{ userId: 'fixture-owner', status: 'active' }] })
    if (path.endsWith('/api/integrations/mcp/shares')) {
      assert.equal(init.method, 'PATCH'); assert.deepEqual(JSON.parse(init.body), { serverId: id(92), workspaceId: id(1), shared: true })
      return Response.json({ error: mcpShareFails ? 'invalidPluginInput' : 'workspaceAccessDenied' }, { status: mcpShareFails ? 400 : 403 })
    }
    if (path.endsWith('/api/integrations/mcp')) {
      assert.equal(init.headers.cookie, 'synthetic-test-session=value'); assert.equal(init.headers.origin, 'https://app.aspectlylabs.com')
      if (init.method === 'GET') return Response.json(mcpPage())
      if (init.method === 'POST') {
        counters.mcpCreate++
        const body = JSON.parse(init.body)
        assert.equal(body.enabled, false); assert.equal(Object.hasOwn(body, 'auth'), false)
        if (mcpCreateThrows) throw Error('PRIVATE upstream MCP create error')
        mcpServer = { ...body, id: id(92), ownerId: 'fixture-owner', mine: true, shared: false, authKind: 'none', revision: 1 }
        return Response.json({ server: mcpServer }, { status: 201 })
      }
      assert.equal(init.method, 'DELETE'); assert.deepEqual(JSON.parse(init.body), { id: id(92) }); counters.mcpDelete++
      if (mcpCleanupFails) return Response.json({ error: 'PRIVATE cleanup failure' }, { status: 503 })
      mcpServer = null; return Response.json({ deleted: true })
    }
    if (path.includes('/e2b-key')) return Response.json({ configured: true, byoEnabled: true, canEdit: true, secret: env.E2B_API_KEY })
    if (path.includes('/model-order')) return Response.json({ location: 'cloud', cloudReady: true, entries: [{ id: 'entry', model: 'deepseek-flash', provider: 'deepseek', harness: 'claude_code', source: { kind: 'api_key', keyId: 'PRIVATE-ID' } }], cloudModels: { entry: 'ready' } })
    if (path.endsWith('/api/conversations')) {
      if (init.method !== 'POST') return Response.json({ conversations: createdGroup ? [{ ...createdGroup,
        createdBy: wrongGroupOwner ? 'other-owner' : 'fixture-owner' }] : [] })
      createdGroup = { ...JSON.parse(init.body), id: id(2), createdBy: 'fixture-owner', kind: 'group', createdAt: new Date().toISOString() }
      return Response.json({ ...createdGroup, rawPrivateBody: env.SMOKE_OWNER_PASSWORD }, { status: 201 })
    }
    if (path.endsWith('/members')) return Response.json({ members: [{ id: 'fixture-owner', memberType: 'user', role: 'owner' },
      ...createdBots.map(bot => ({ id: bot.id, memberType: 'bot', role: 'member' }))] })
    if (path.endsWith('/decisions')) return Response.json({ turns: [{ messageId: id(40), status: 'failed', error: stopped ? 'stopped' : 'group_judgment_pending',
      trace: { status: stopped ? 'stopped' : 'pending', events: withTask ? [{ type: 'delegate', outcome: 'succeeded', memberId: id(11), taskId: id(3), runId: id(7) }] : [] } }] })
    if (path.endsWith('/stop')) {
      assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), {}); counters.groupStop++; stopped = true
      if (unknownStop) throw Error('PRIVATE unknown stop response')
      return Response.json({ stopped: 1 })
    }
    if (path.endsWith('/sign-out')) { counters.signout++; return Response.json({ success: true }, {
      status: init.headers?.['x-fixture-session'] === 'helper' ? helperLogoutStatus : init.headers?.['x-fixture-session'] === 'group' ? groupLogoutStatus : 200 }) }
    if (path.endsWith('/api/factory/tasks/' + id(3))) {
      if (init.method === 'POST') { counters.cancel++; taskCancelled = true; assert.equal(JSON.parse(init.body).action, 'cancel'); return Response.json({}) }
      return Response.json({ task: { id: id(3), botId: wrongTaskOwner ? id(99) : id(11), issueId: id(5), attemptId: id(6), candidateId: null,
        sourceEventId: taskEpochChangesAfterMs !== null && elapsed >= taskEpochChangesAfterMs ? id(9) : id(8),
        revision: 2, stage: 'execute', status: taskCancelled ? 'cancelled' : 'running' },
        attempts: [{ id: id(6), runId: id(7), output: { requestEpoch: id(8) } }] })
    }
    if (path.endsWith('/api/runs/' + id(7) + '/evidence')) return Response.json({ run: { id: id(7), botId: id(11), issueId: id(5),
      status: terminalAfterMs !== null && elapsed >= terminalAfterMs ? 'stopped' : runStatus,
      executionIdentity: { requester: wrongRunOwner ? 'foreign-owner' : 'fixture-owner', executionPrincipal: 'fixture-owner', outputOwner: 'fixture-owner',
        botId: id(11), botOwner: 'fixture-owner', workspaceId: id(1), billingAccount: { runtime: { kind: 'e2b', ownerId: 'fixture-owner' } } } }, artifacts: [], rawSecret: 'PRIVATE_RUN' })
    if (path.endsWith('/api/threads/' + id(7) + '/machine')) {
      assert.equal(helperActive, true); assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { action: 'end' })
      counters.machineEnd++
      if (unknownMachineEnd) throw Error('PRIVATE unknown machine-end response')
      return Response.json(machineEndStatus === 200 ? { runId: id(7), state: 'ended' } : { error: 'unavailable' }, { status: machineEndStatus })
    }
    if (path.endsWith('/api/bots/' + id(11) + '/computer')) {
      assert.equal(init.method, 'GET'); return Response.json({ machine: 'running', control: 'idle', pendingApproval: { text: 'PRIVATE_PROMPT' }, lastAction: 'PRIVATE_ACTION' })
    }
    throw Error('unexpected_fixture_url')
  }
  const dependencies = {
    isSmokeAccountEmail: email => email === env.SMOKE_OWNER_EMAIL,
    replayContract,
    async withTemporaryFlashCredential(run, options) {
      counters.helper++; assert.equal(options.cloudExecution, true)
      const cleanup = { created: true, removed: false, cloudCreated: true, cloudRemoved: false }
      helperActive = true
      await options.fetchImpl('https://app.aspectlylabs.com/mikka/api/auth/sign-in/email', { method: 'POST', body: '{}' })
      try { return await run(cleanup) }
      finally { cleanup.removed = true; cleanup.cloudRemoved = true; helperActive = false
        await options.fetchImpl('https://app.aspectlylabs.com/mikka/api/auth/sign-out', { method: 'POST', body: '{}', headers: { 'x-fixture-session': 'helper' } }).catch(() => {}) }
    },
    async runGroupProductionAcceptance({ fetchImpl: fetch }) {
      counters.group++; assert.equal(helperActive, true)
      assert.equal(counters.mcpCreate, 1)
      assert.equal(counters.mcpDelete, mcpCreateThrows ? 0 : 1, 'owner fixture cleanup is attempted before group execution')
      await fetch('https://app.aspectlylabs.com/mikka/api/auth/sign-in/email', { method: 'POST', body: '{}' })
      try {
        for (const role of ['UI', 'Coding', 'Testing']) await fetch('https://app.aspectlylabs.com/mikka/api/bots', { method: 'POST', body: JSON.stringify({ name: `Acceptance ${role} ${marker}` }) })
        await fetch('https://app.aspectlylabs.com/mikka/api/conversations', { method: 'POST', body: JSON.stringify({ workspaceId: id(1), title: `Proactive acceptance ${marker}`,
          members: createdBots.map(bot => ({ memberType: 'bot', memberId: bot.id })) }) })
        if (throwsAfterCreation) throw Error('PRIVATE upstream body')
        return { status: groupFails ? 'fail' : 'pass', conversationId: id(2), workspaceId: id(1), requesterId: 'fixture-owner', sessionEnded: groupLogoutStatus === 200, rawSecret: env.DEEPSEEK_API_KEY,
          groupCleanup: groupFails ? { status: sourceStopUnknown ? 'failed' : 'stopped', conversationId: id(2), attempted: true,
            acknowledged: !sourceStopUnknown, noPendingRetry: !sourceStopUnknown, executionStopConfirmed: false, delegatedTaskIds: [] } : null,
          cases: withTask ? [{ name: 'group-factory-artifact-continuation-stop', status: groupFails ? 'fail' : 'pass', taskId: id(3), reporterId: id(11), issueId: id(5),
            messages: [{ operation: 'create', messageId: id(40), taskId: id(3), runId: id(7) }] }] : [] }
      } finally { await fetch('https://app.aspectlylabs.com/mikka/api/auth/sign-out', { method: 'POST', body: '{}', headers: { 'x-fixture-session': 'group' } }) }
    },
    async runGroupDecisionReplay({ env: supplied }) {
      counters.replay++; assert.equal(helperActive, true)
      assert.equal(supplied.GROUP_REPLAY_CONVERSATION, id(2))
      assert.equal(supplied.GROUP_REPLAY_DEPLOYMENT, env.GROUP_ACCEPTANCE_DEPLOYMENT)
      assert.equal(supplied.GROUP_REPLAY_REVISION, env.GROUP_ACCEPTANCE_REVISION)
      assert.equal(supplied.GROUP_REPLAY_COOKIE, 'synthetic-test-session=value'); assert.equal(supplied.GROUP_REPLAY_TOKEN, undefined)
      if (replayFails) throw Error('PRIVATE upstream failure')
      return mutateReplay(replay())
    },
  }
  return { calls, counters, elapsed: () => elapsed, run: () => runAcceptanceBundle({ env, fetchImpl, dependencies,
    now: () => elapsed, wait: async ms => { elapsed += ms }, verifySource: () => env.GROUP_ACCEPTANCE_REVISION }) }
}

test('source, origin and deployment fail before any network or credential setup', async () => {
  let calls = 0
  for (const input of [{ GROUP_ACCEPTANCE_REVISION: 'bad' }, { GROUP_ACCEPTANCE_ORIGIN: 'https://foreign.invalid' }])
    await assert.rejects(runAcceptanceBundle({ env: { ...env, ...input }, fetchImpl: async () => { calls++; }, verifySource: () => env.GROUP_ACCEPTANCE_REVISION }))
  await assert.rejects(runAcceptanceBundle({ env, fetchImpl: async () => { calls++; }, verifySource: () => 'b'.repeat(40) }), /source_revision_mismatch/)
  assert.equal(calls, 0)
})

test('Factory failure preserves its group and independently executes all 24 receipted replay fixtures', async () => {
  const f = fixture({ withTask: true }), report = await f.run()
  assert.equal(report.status, 'fail'); assert.equal(report.group.status, 'fail'); assert.equal(report.replay.status, 'complete')
  assert.equal(report.ownerMcp.status, 'passed'); assert.equal(report.ownerMcp.cleanup.absentReadback, true)
  assert.equal(report.actualReceiptedDecisionReplays, 24); assert.equal(report.fixtureConversationId, id(2))
  assert.equal(report.runtime.order.entries[0].cloudModelState, 'ready')
  assert.equal(report.taskCleanup.status, 'cancellation-recorded'); assert.equal(f.counters.cancel, 1)
  assert.deepEqual(report.credentialCleanup, { created: true, removed: true, cloudCreated: true, cloudRemoved: true,
    credentialSessionLogoutAttempted: true, credentialSessionLogoutAcknowledged: true, credentialSessionLogoutStatus: 200 })
  assert.equal(report.replaySessionEnded, true); assert.equal(f.counters.signout, 3)
  assert.equal(report.taskCleanup.executionStopConfirmed, false); assert.equal(report.taskCleanup.cloudStopConfirmed, false)
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password-only|synthetic-deepseek-only|synthetic-cloud-only|PRIVATE-ID|synthetic-test-session/)
})

test('an interrupted group driver still leaves a captured creation receipt for replay', async () => {
  const f = fixture({ throwsAfterCreation: true }), report = await f.run()
  assert.equal(report.fixtureConversationId, id(2)); assert.equal(f.counters.replay, 1)
  assert.equal(report.group.error, 'acceptance_runner_failed')
  assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(f.counters.groupStop, 1); assert.equal(report.groupCleanup.noPendingRetry, true)
  assert.equal(report.groupCleanup.executionStopConfirmed, false)
  assert.ok(!f.calls.some(call => call.path.endsWith('/messages')))
})

test('24 logical replay cases with 36 distinct provider receipts pass with separate unknown cost accounting', async () => {
  const f = fixture({ groupFails: false }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(report.ownerMcp.status, 'passed'); assert.equal(report.ownerMcp.http.share, 403)
  assert.equal(report.ownerMcp.cleanup.deleteAcknowledged, true); assert.equal(report.ownerMcp.cleanup.absentReadback, true)
  assert.equal(f.counters.mcpCreate, 1); assert.equal(f.counters.mcpDelete, 1)
  assert.equal(report.replay.baseline[0].receipt.modelId, 'openai/gpt-6-luna-decisions')
  assert.equal(report.completedLogicalDecisionReplays, 24)
  assert.deepEqual(report.replayAccounting.decisionCalls, { attempted: 36, receipted: 36, unreceipted: 0 })
  assert.equal(report.replayAccounting.decisionCost.unknownCalls, 36)
  assert.equal(report.replayAccounting.decisionCostUsd, null)
  assert.equal(report.replay.candidate[0].decisions.length, 2)
  for (const session of Object.values(report.sessionCleanup)) assert.equal(session.logoutStatus, 200)
})

test('duplicate provider evidence, duplicate cases and reordered chains cannot pass', async () => {
  for (const mutateReplay of [
    value => { value.candidate[0].decisions[1].receipt = value.baseline[0].receipt; return value },
    value => { value.candidate[1].caseId = value.candidate[0].caseId; return value },
    value => { value.candidate[0].decisions.reverse(); return value },
  ]) {
    const report = await fixture({ groupFails: false, mutateReplay }).run()
    assert.equal(report.status, 'fail'); assert.equal(report.replayAccounting.valid, false)
    assert.equal(report.credentialCleanup.credentialSessionLogoutAcknowledged, true)
  }
})

test('a complete four-phase delegation chain includes its actual report-timing receipt', async () => {
  const f = fixture({ groupFails: false, mutateReplay: value => {
    const row = value.candidate[0]
    row.decisions = ['intent', 'delegation', 'responder', 'report_timing'].map((phase, index) => ({
      id: id(910 + index), phase, index, status: 'complete', failure: null,
      receipt: { ...receipt, executionId: `delegation-execution-${index}`, providerGenerationId: `delegation-generation-${index}` },
      decisionCostUsd: null,
    }))
    row.receipt = row.decisions[0].receipt
    row.decisionCalls = { attempted: 4, receipted: 4, unreceipted: 0 }
    row.decisionCost = { knownUsd: 0, knownCalls: 0, unknownCalls: 4, omittedCalls: 0 }
    return value
  } })
  const report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.completedLogicalDecisionReplays, 24)
  assert.equal(report.replayAccounting.decisionCalls.receipted, 38)
  assert.equal(report.replay.candidate[0].decisions[3].phase, 'report_timing')
  assert.equal(report.replayAccounting.decisionCostUsd, null)
})

test('an invalid charged chain and an unreceipted request retain their evidence and unknown costs', () => {
  const value = replay(), row = value.baseline[0]
  row.status = 'invalid_decision'; row.failureReason = 'invalid_response'
  row.decisions[0].status = 'invalid_decision'; row.decisions[0].failure = 'invalid_response'
  row.decisions.push({ id: id(901), phase: 'responder', index: 1, status: 'unavailable', failure: 'unavailable', receipt: null, decisionCostUsd: null })
  value.baseline = [row]; value.candidate = []; value.status = 'failed'
  const account = measureReplayEvidence(value, replayContract), projected = sanitizeReplayReport(value)
  assert.equal(account.valid, false); assert.equal(account.receiptedLogicalReplays, 1)
  assert.deepEqual(account.decisionCalls, { attempted: 2, receipted: 1, unreceipted: 1 })
  assert.equal(account.decisionCost.unknownCalls, 2); assert.equal(account.decisionCostUsd, null)
  assert.equal(projected.baseline[0].failureReason, 'invalid_response')
  assert.equal(projected.baseline[0].decisions[0].receipt.providerGenerationId, row.receipt.providerGenerationId)
})

test('the temporary credential session must acknowledge its own logout even when the helper swallows HTTP failure', async () => {
  const report = await fixture({ groupFails: false, helperLogoutStatus: 503 }).run()
  assert.equal(report.status, 'fail'); assert.equal(report.replaySessionEnded, true)
  assert.equal(report.credentialCleanup.removed, true)
  assert.equal(report.credentialCleanup.credentialSessionLogoutAttempted, true)
  assert.equal(report.credentialCleanup.credentialSessionLogoutAcknowledged, false)
  assert.equal(report.credentialCleanup.credentialSessionLogoutStatus, 503)
  assert.equal(report.sessionCleanup.groupRuntime.logoutAcknowledged, true)
})

test('only the bound terminal fixture run receives one intentional machine-end before credentials are removed', async () => {
  const f = fixture({ groupFails: false, withTask: true }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(f.counters.machineEnd, 1)
  assert.equal(report.machineCleanup.machineEndAcknowledged, true)
  assert.equal(report.machineCleanup.executionStopConfirmed, true)
  assert.equal(report.machineCleanup.runs[0].runId, id(7))
  assert.equal(report.machineCleanup.runs[0].machineEndHttpStatus, 200)
  assert.equal(report.machineCleanup.independentProviderObservation, false)
  assert.equal(report.machineCleanup.perRunExternalStatus, 'unknown')
  assert.equal(report.machineCleanup.sharedDesktop.machine, 'running')
  assert.equal(report.machineCleanup.sharedDesktop.provesThreadMachineStop, false)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
})

test('a foreign execution principal or an active run prevents any machine-end request', async () => {
  for (const option of [{ wrongRunOwner: true }, { runStatus: 'running' }]) {
    const f = fixture({ groupFails: false, withTask: true, ...option }), report = await f.run()
    assert.equal(report.status, 'fail'); assert.equal(f.counters.machineEnd, 0)
    assert.equal(report.machineCleanup.machineEndAcknowledged, false)
    assert.equal(report.credentialCleanup.removed, true)
  }
})

test('normal asynchronous run-stop acknowledgement is awaited within the existing 180s budget', async () => {
  const f = fixture({ groupFails: false, withTask: true, runStatus: 'running', terminalAfterMs: 2000 }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(f.counters.machineEnd, 1)
  assert.equal(f.elapsed(), 2000)
  assert.equal(report.machineCleanup.terminalWaitBudgetMs, 180000)
  assert.equal(report.machineCleanup.terminalWaitElapsedMs, 2000)
  assert.equal(report.machineCleanup.terminalPolls, 2)
  assert.equal(report.credentialCleanup.cloudRemoved, true)
})

test('terminal wait expiry or a changed Task epoch never authorizes a machine end', async () => {
  const expired = fixture({ groupFails: false, withTask: true, runStatus: 'running' }), timeout = await expired.run()
  assert.equal(expired.elapsed(), 180000); assert.equal(expired.counters.machineEnd, 0)
  assert.equal(timeout.machineCleanup.error, 'acceptance_machine_cleanup_runs_active')
  assert.equal(timeout.machineCleanup.executionStopConfirmed, false); assert.equal(timeout.status, 'fail')
  const changed = fixture({ groupFails: false, withTask: true, runStatus: 'running', terminalAfterMs: 2000, taskEpochChangesAfterMs: 2000 }), drift = await changed.run()
  assert.equal(changed.elapsed(), 2000); assert.equal(changed.counters.machineEnd, 0)
  assert.equal(drift.machineCleanup.error, 'acceptance_machine_cleanup_epoch_scope')
  assert.equal(drift.status, 'fail'); assert.equal(drift.credentialCleanup.cloudRemoved, true)
})

test('404 and unknown machine-end acknowledgements never prove shutdown and are never repeated', async () => {
  for (const option of [{ machineEndStatus: 404 }, { unknownMachineEnd: true }]) {
    const f = fixture({ groupFails: false, withTask: true, ...option }), report = await f.run()
    assert.equal(report.status, 'fail'); assert.equal(f.counters.machineEnd, 1)
    assert.equal(report.machineCleanup.machineEndAcknowledged, false)
    assert.equal(report.machineCleanup.independentProviderObservation, false)
    assert.equal(report.credentialCleanup.cloudRemoved, true)
  }
})

test('fallback stop checks current owner, reads unknown writes once, and never replays a source stop', async () => {
  const foreign = fixture({ throwsAfterCreation: true, wrongGroupOwner: true }), denied = await foreign.run()
  assert.equal(foreign.counters.groupStop, 0); assert.equal(foreign.counters.replay, 0)
  assert.equal(denied.groupCleanup.error, 'acceptance_group_cleanup_scope')
  const unknown = fixture({ throwsAfterCreation: true, unknownStop: true }), observed = await unknown.run()
  assert.equal(unknown.counters.groupStop, 1); assert.equal(unknown.counters.replay, 1)
  assert.equal(observed.groupCleanup.acknowledged, false); assert.equal(observed.groupCleanup.noPendingRetry, true)
  assert.equal(observed.status, 'fail')
  const returned = fixture({ sourceStopUnknown: true }), notRepeated = await returned.run()
  assert.equal(returned.counters.groupStop, 0); assert.equal(returned.counters.replay, 0)
  assert.equal(notRepeated.groupCleanup.source, 'source-driver')
})

test('replay failure still signs out and cleans credentials; no upstream text is emitted', async () => {
  const f = fixture({ replayFails: true }), report = await f.run()
  assert.equal(report.replay.error, 'replay_request_failed'); assert.equal(report.status, 'fail')
  assert.equal(report.credentialCleanup.removed, true); assert.equal(report.credentialCleanup.cloudRemoved, true)
  assert.equal(report.replaySessionEnded, true); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
})

test('cleanup rejects a task whose Bot differs from this fixture reporter', async () => {
  const f = fixture({ withTask: true, wrongTaskOwner: true }), report = await f.run()
  assert.equal(report.taskCleanup.error, 'acceptance_cleanup_task_scope'); assert.equal(f.counters.cancel, 0)
})

test('owner MCP boundary failure remains independent while group and all replay observations continue', async () => {
  const f = fixture({ groupFails: false, mcpShareFails: true }), report = await f.run()
  assert.equal(report.ownerMcp.status, 'failed'); assert.equal(report.ownerMcp.http.share, 400)
  assert.equal(report.ownerMcp.checks.personalShareRejected, false); assert.equal(report.ownerMcp.cleanup.absentReadback, true)
  assert.equal(report.group.status, 'pass'); assert.equal(report.replay.status, 'complete'); assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(f.counters.group, 1); assert.equal(f.counters.replay, 1); assert.equal(report.status, 'fail')
  assert.equal(report.replaySessionEnded, true); assert.equal(report.credentialCleanup.removed, true)
})

test('failed owner MCP cleanup blocks the overall pass without retrying or skipping independent checks', async () => {
  const f = fixture({ groupFails: false, mcpCleanupFails: true }), report = await f.run()
  assert.equal(report.ownerMcp.status, 'failed'); assert.equal(report.ownerMcp.connectionId, id(92))
  assert.equal(report.ownerMcp.cleanup.deleteAcknowledged, false); assert.equal(report.ownerMcp.cleanup.absentReadback, false)
  assert.equal(f.counters.mcpDelete, 1); assert.equal(report.group.status, 'pass'); assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(report.status, 'fail'); assert.equal(report.replaySessionEnded, true)
  assert.equal(report.credentialCleanup.cloudRemoved, true); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
})

test('unknown owner MCP creation has no guessed cleanup and still allows group and replay evidence', async () => {
  const f = fixture({ groupFails: false, mcpCreateThrows: true }), report = await f.run()
  assert.equal(report.ownerMcp.status, 'failed'); assert.equal(report.ownerMcp.connectionId, null)
  assert.equal(f.counters.mcpCreate, 1); assert.equal(f.counters.mcpDelete, 0)
  assert.equal(report.group.status, 'pass'); assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(report.status, 'fail'); assert.equal(report.replaySessionEnded, true)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
})

test('deployment drift during owner MCP cleanup stops group/model work while normal cleanup and logout finish', async () => {
  const f = fixture({ groupFails: false, driftAfterMcp: true }), report = await f.run()
  assert.equal(report.ownerMcp.status, 'failed'); assert.equal(report.ownerMcp.cleanup.absentReadback, true)
  assert.equal(report.error, 'acceptance_deployment_changed'); assert.equal(report.status, 'fail')
  assert.equal(f.counters.group, 0); assert.equal(f.counters.replay, 0)
  assert.equal(report.replaySessionEnded, true); assert.equal(report.credentialCleanup.removed, true); assert.equal(report.credentialCleanup.cloudRemoved, true)
})

test('reports retain only allowlisted metadata and refuse credential-bearing output', () => {
  const source = { status: 'fail', email: 'secret@example.invalid', cookie: 'PRIVATE_COOKIE', cases: [{ name: 'fixture', body: 'PRIVATE_PROMPT', decision: { ...receipt, apiKey: 'PRIVATE_KEY' }, artifact: { artifactId: id(1), url: 'https://private.invalid' } }] }
  const group = sanitizeGroupReport(source), replayed = sanitizeReplayReport({ ...replay(), cookie: 'PRIVATE_COOKIE' })
  const ownerMcp = sanitizeOwnerMcpReport({ status: 'failed', name: 'PRIVATE MCP', url: 'https://private.invalid', email: 'secret@example.invalid',
    cookie: 'PRIVATE_COOKIE', errors: ['PRIVATE raw error', 'owner_mcp_cleanup_remaining'], cleanup: { absentReadback: false, credential: 'PRIVATE_SECRET' } })
  assert.doesNotMatch(JSON.stringify({ group, replayed, ownerMcp }), /PRIVATE|private\.invalid|secret@example/)
  const directory = mkdtempSync(join(tmpdir(), 'proactive-runner-fixture-')), output = join(directory, 'safe.json')
  writeSanitizedReport({ group, replayed, ownerMcp }, output, env)
  assert.equal(statSync(output).mode & 0o777, 0o600); assert.ok(readFileSync(output, 'utf8').includes('openai/gpt-6-luna-decisions'))
  assert.throws(() => writeSanitizedReport({ unexpected: env.DEEPSEEK_API_KEY }, join(directory, 'rejected.json'), env), /secret_detected/)
  assert.throws(() => writeSanitizedReport({ cookie: 'short' }, join(directory, 'rejected-field.json'), env), /private_field_detected/)
})
