import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runAcceptanceBundle, sanitizeGroupReport, sanitizeReplayReport, sanitizeOwnerMcpReport, writeSanitizedReport } from './run-proactive-acceptance.mjs'

const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const env = { GROUP_ACCEPTANCE_DEPLOYMENT: 'dpl_fixture', GROUP_ACCEPTANCE_REVISION: 'a'.repeat(40),
  SMOKE_OWNER_EMAIL: 'alexjiang20232024+mikka-smoke-owner@gmail.com', SMOKE_OWNER_PASSWORD: 'synthetic-password-only',
  DEEPSEEK_API_KEY: 'synthetic-deepseek-only', E2B_API_KEY: 'synthetic-cloud-only' }
const receipt = { executionId: 'synthetic-execution', providerGenerationId: 'synthetic-generation', modelId: 'openai/gpt-6-luna-decisions',
  requestDigest: 'a'.repeat(64), startedAt: '2026-11-03T00:00:00Z', completedAt: '2026-11-03T00:00:00.100Z', imageDigests: [], vision: 'no-image-input' }
const replay = () => ({ status: 'complete', baseline: Array.from({ length: 12 }, (_, i) => ({ caseId: `case-${i}`, receipt })),
  candidate: Array.from({ length: 12 }, (_, i) => ({ caseId: `case-${i}`, receipt })), comparison: { decisionReviewReady: true } })

function fixture({ groupFails = true, throwsAfterCreation = false, replayFails = false, withTask = false, wrongTaskOwner = false,
  mcpShareFails = false, mcpCleanupFails = false, mcpCreateThrows = false, driftAfterMcp = false } = {}) {
  const calls = [], counters = { helper: 0, group: 0, replay: 0, signout: 0, cancel: 0, mcpCreate: 0, mcpDelete: 0 }
  let helperActive = false, mcpServer = null
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
    if (path.endsWith('/api/bots')) return Response.json([{ id: id(91), workspaceId: id(1), ownerId: 'fixture-owner' }])
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
    if (path.endsWith('/api/conversations')) return Response.json({ id: id(2), rawPrivateBody: env.SMOKE_OWNER_PASSWORD })
    if (path.endsWith('/sign-out')) { counters.signout++; return Response.json({ success: true }) }
    if (path.endsWith('/api/factory/tasks/' + id(3))) {
      if (init.method === 'POST') { counters.cancel++; assert.equal(JSON.parse(init.body).action, 'cancel'); return Response.json({}) }
      return Response.json({ task: { id: id(3), botId: wrongTaskOwner ? id(99) : id(4), issueId: id(5), attemptId: id(6), candidateId: null, revision: 2, stage: 'execute', status: 'running' } })
    }
    throw Error('unexpected_fixture_url')
  }
  const dependencies = {
    isSmokeAccountEmail: email => email === env.SMOKE_OWNER_EMAIL,
    async withTemporaryFlashCredential(run, options) {
      counters.helper++; assert.equal(options.cloudExecution, true)
      const cleanup = { created: true, removed: false, cloudCreated: true, cloudRemoved: false }
      helperActive = true
      try { return await run(cleanup) }
      finally { cleanup.removed = true; cleanup.cloudRemoved = true; helperActive = false }
    },
    async runGroupProductionAcceptance({ fetchImpl: fetch }) {
      counters.group++; assert.equal(helperActive, true)
      assert.equal(counters.mcpCreate, 1)
      assert.equal(counters.mcpDelete, mcpCreateThrows ? 0 : 1, 'owner fixture cleanup is attempted before group execution')
      await fetch('https://app.aspectlylabs.com/mikka/api/conversations', { method: 'POST', body: '{}' })
      if (throwsAfterCreation) throw Error('PRIVATE upstream body')
      return { status: groupFails ? 'fail' : 'pass', conversationId: id(2), workspaceId: id(1), rawSecret: env.DEEPSEEK_API_KEY,
        cases: withTask ? [{ name: 'group-factory-artifact-continuation-stop', status: 'fail', taskId: id(3), reporterId: id(4), issueId: id(5) }] : [] }
    },
    async runGroupDecisionReplay({ env: supplied }) {
      counters.replay++; assert.equal(helperActive, true)
      assert.equal(supplied.GROUP_REPLAY_CONVERSATION, id(2))
      assert.equal(supplied.GROUP_REPLAY_DEPLOYMENT, env.GROUP_ACCEPTANCE_DEPLOYMENT)
      assert.equal(supplied.GROUP_REPLAY_REVISION, env.GROUP_ACCEPTANCE_REVISION)
      assert.equal(supplied.GROUP_REPLAY_COOKIE, 'synthetic-test-session=value'); assert.equal(supplied.GROUP_REPLAY_TOKEN, undefined)
      if (replayFails) throw Error('PRIVATE upstream failure')
      return replay()
    },
  }
  return { calls, counters, run: () => runAcceptanceBundle({ env, fetchImpl, dependencies, verifySource: () => env.GROUP_ACCEPTANCE_REVISION }) }
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
  assert.deepEqual(report.credentialCleanup, { created: true, removed: true, cloudCreated: true, cloudRemoved: true })
  assert.equal(report.replaySessionEnded, true); assert.equal(f.counters.signout, 1)
  assert.doesNotMatch(JSON.stringify(report), /synthetic-password-only|synthetic-deepseek-only|synthetic-cloud-only|PRIVATE-ID|synthetic-test-session/)
})

test('an interrupted group driver still leaves a captured creation receipt for replay', async () => {
  const f = fixture({ throwsAfterCreation: true }), report = await f.run()
  assert.equal(report.fixtureConversationId, id(2)); assert.equal(f.counters.replay, 1)
  assert.equal(report.group.error, 'acceptance_runner_failed')
  assert.equal(report.actualReceiptedDecisionReplays, 24)
})

test('only complete owner MCP, group runtime, 24 receipts, reviewed replay and cleanup pass', async () => {
  const f = fixture({ groupFails: false }), report = await f.run()
  assert.equal(report.status, 'pass'); assert.equal(report.actualReceiptedDecisionReplays, 24)
  assert.equal(report.ownerMcp.status, 'passed'); assert.equal(report.ownerMcp.http.share, 403)
  assert.equal(report.ownerMcp.cleanup.deleteAcknowledged, true); assert.equal(report.ownerMcp.cleanup.absentReadback, true)
  assert.equal(f.counters.mcpCreate, 1); assert.equal(f.counters.mcpDelete, 1)
  assert.equal(report.replay.baseline[0].receipt.modelId, 'openai/gpt-6-luna-decisions')
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
