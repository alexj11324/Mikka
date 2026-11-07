import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateReceipt, validateTemplateSubscriptions, validateSubscriptionFiles } from './validate-template-subscriptions.mjs'
import { observeChunks } from '../acceptance/cloud-startup.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMMIT = 'a'.repeat(40), WORKER = 'b'.repeat(40)
const DEVICE = '10000000-0000-4000-8000-000000000001', RUN = '10000000-0000-4000-8000-000000000002'
const TEAM = '10000000-0000-4000-8000-000000000003', PERSONAL = '10000000-0000-4000-8000-000000000004'
const OWNER = 'fixture-smoke-owner', ADMIN = 'fixture-shared-admin', EMAIL = 'acceptance+mikka-smoke@example.invalid'
const hash = value => createHash('sha256').update(value).digest('hex')
const team = { teamWorkspaceConfirmed: true, teamWorkspaceHash: hash('team-workspace\0' + TEAM), teamAdminMembershipVerified: true }
const sharedScope = { verified: true, access: 'workspace_share', requesterHash: hash(OWNER).slice(0, 16), payerHash: hash(ADMIN).slice(0, 16),
  workspaceHash: team.teamWorkspaceHash, connectionHash: 'e'.repeat(16), bindingHash: 'f'.repeat(16), connectionRevision: '2', profileVersion: 1, profileDigest: 'e'.repeat(64) }
const report = { sourceCommit: COMMIT, workerSha: WORKER, templates: Object.fromEntries(['claude', 'codex'].map(kind => [kind, {
  templateId: `candidate-${kind}`, baseTemplate: kind, preinstalled: true,
}])) }
const proof = { deviceId: DEVICE, binarySha256: 'c'.repeat(64), version: '0.163.0' }
const accepted = harness => ({ mode: 'candidate', status: 'candidate_subscription_proved', accountHash: hash(OWNER).slice(0, 16), team,
  cleanup: { errors: [], workspaceRestored: true }, officialTiming: { enabled: true, cleaned: true }, samples: [{
  status: 'execution_proved_awaiting_server_timing', sourceCommit: COMMIT, harness, runId: RUN,
  execution: { harness, model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', deviceId: DEVICE, credentialType: 'subscription', sharedScope: { ...sharedScope } },
  credentialRoute: 'subscription', replyVerified: true, cleanup: { status: 'passed' },
  minToolCalls: 1, requireReplyAfterTool: true, replyVerifiedAfterTool: true, toolCalls: [{ toolCallHash: 'd'.repeat(16), outcome: 'ok' }],
  requireAgentAcceptance: true, requireRuntimeReceipt: true, requireOfficialTiming: true,
  runtimeTiming: { version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit',
    scope: 'daemon_http_server_link_and_task_fetch', allFirstPartyHttpComplete: false,
    runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16), harness, complete: true, truncated: false,
    startedAt: 1000, endedAt: 2000, ms: 1000, executionStartMs: 100, executionEndMs: 900,
    requests: [], counts: [], providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0,
    agentAccepted: { kind: harness === 'codex' ? 'codex_turn_start_ack' : 'claude_user_ack', at: 1100, ms: 100 },
    mcpHttpTiming: { version: 1, source: 'mikka_mcp_physical_fetch', scope: 'observed_mikka_mcp_children',
      generationCoverage: 'unverified', allFirstPartyHttpComplete: false, remoteMcpServerCount: 0, childPathAuditVersion: 1,
      runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16), harness, startedAt: 1010, endedAt: 1900,
      expectedChildren: 1, observedChildren: 1, closedChildren: 0, observedComplete: true, childLifecycleComplete: false,
      rejectedEvents: 0, truncated: false,
      children: [{ child: 1, startedAt: 1020, closedAt: null, lastSequence: 3, sent: 1, completed: 1, lost: 0 }],
      requests: [{ child: 1, sequence: 1, operation: 'decision_catalogue', startedAt: 1040, endedAt: 1050, durationMs: 10, status: 200, outcome: 'ok' }] },
    officialCliTiming: { version: 1, source: 'official_cli_otlp', runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16),
      harness, startedAt: 1010, endedAt: 1900, collection: 'best_effort', flush: 'not_confirmed', cliExitObserved: true,
      batches: 1, recordsReceived: 1, duplicates: 0, rejectedBatches: 0, invalidEvents: 0, ignoredRecords: 0, truncated: false,
      events: [{ name: `${harness}.api_request`, kind: 'provider', receivedAt: 1600, eventAt: 1500, durationMs: 100,
        model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', outcome: 'ok', status: 200, attempt: 1, sequence: 1 }] } },
}] })

test('the production gate logs in as SMOKE without pinning an owner workspace or bot', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/e2b-official-runtime.yml', import.meta.url), 'utf8')
  assert.match(workflow, /secret-name: SMOKE_OWNER_EMAIL/)
  assert.match(workflow, /secret-name: SMOKE_OWNER_PASSWORD/)
  assert.doesNotMatch(workflow, /ACME_DEMO_|MIKKA_ACCEPTANCE_(?:WORKSPACE|BOT)_ID:/)
})

test('a different application commit is refused before login, enrollment or candidate creation', async () => {
  const calls = []
  await assert.rejects(validateTemplateSubscriptions(report, {
    env: { GITHUB_SHA: COMMIT, SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: 'fixture' },
    fetchImpl: async input => { calls.push(new URL(input).pathname); return Response.json({ build: 'f'.repeat(40) }) },
    sandboxFactory: () => assert.fail('candidate must not be created'),
  }), /template_gate_application_build_mismatch/)
  assert.deepEqual(calls, ['/mikka/api/version'])
})

test('a release receipt names the actual candidate, revision, model and registered device', () => {
  const receipt = candidateReceipt(report, 'codex', proof, accepted('codex'))
  assert.deepEqual(receipt, { status: 'passed', templateId: 'candidate-codex', sourceCommit: COMMIT, workerSha: WORKER,
    harness: 'codex', model: 'gpt-6-luna', credentialRoute: 'subscription', replyVerified: true, runId: RUN,
    replyVerifiedAfterTool: true, toolEvidence: { toolCallHash: 'd'.repeat(16), outcome: 'ok' },
    deviceId: DEVICE, officialBinarySha256: proof.binarySha256, officialCliVersion: proof.version,
    sharedScope,
    agentAcceptance: { runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16), harness: 'codex', kind: 'codex_turn_start_ack', at: 1100, ms: 100 },
    runtimeAuthorization: { source: 'http_server_link', scope: 'daemon_http_server_link_and_task_fetch', complete: true, truncated: false, extraRemoteCalls: 0,
      hostAuthorizationComplete: true, basis: 'host_authorization_census_and_closed_mcp_business_paths', allFirstPartyHttpComplete: false,
      mcpHttpTiming: accepted('codex').samples[0].runtimeTiming.mcpHttpTiming,
      observedProviderEvents: 1, officialDelivery: 'best_effort_not_a_complete_call_count' } })
  for (const mutate of [
    sample => { sample.replyVerified = false }, sample => { sample.execution.credentialType = 'api_key' },
    sample => { sample.execution.deviceId = RUN }, sample => { sample.execution.model = 'other' },
    sample => { sample.sourceCommit = 'd'.repeat(40) }, sample => { sample.cleanup.status = 'failed' },
    sample => { sample.runtimeTiming.agentAccepted.kind = 'claude_system_init' },
    sample => { sample.runtimeTiming.runIdHash = 'f'.repeat(16) },
    sample => { delete sample.runtimeTiming.agentAccepted },
    sample => { sample.runtimeTiming.truncated = true },
    sample => { delete sample.runtimeTiming.mcpHttpTiming },
    sample => { sample.runtimeTiming.mcpHttpTiming.remoteMcpServerCount = 1 },
    sample => { sample.runtimeTiming.mcpHttpTiming.allFirstPartyHttpComplete = true },
    sample => { sample.runtimeTiming.officialCliTiming.events = [] },
    sample => { sample.requireOfficialTiming = false },
    sample => { sample.minToolCalls = 0 }, sample => { sample.toolCalls = [] },
    sample => { sample.toolCalls[0].outcome = 'error' }, sample => { sample.toolCalls[0].toolCallHash = 'raw-tool-id' },
    sample => { sample.replyVerifiedAfterTool = false }, sample => { sample.requireReplyAfterTool = false },
    sample => { sample.execution.sharedScope.verified = false }, sample => { sample.execution.sharedScope.access = 'owner' },
    sample => { sample.execution.sharedScope.payerHash = sample.execution.sharedScope.requesterHash },
    sample => { sample.execution.sharedScope.workspaceHash = 'f'.repeat(64) },
    sample => { sample.execution.sharedScope.connectionRevision = 'private-response' },
  ]) {
    const value = accepted('codex'); mutate(value.samples[0])
    assert.throws(() => candidateReceipt(report, 'codex', proof, value), /template_gate_/)
  }
})

function candidateFixture(runAcceptance, cleanupFailure, { failRestore = false, proofOverride = {} } = {}) {
  const events = [], devices = []
  const fetchImpl = async (input, init) => {
    const url = new URL(input), path = url.pathname
    if (path.endsWith('/api/version')) return Response.json({ build: COMMIT })
    if (path.endsWith('/api/auth/sign-in/email')) {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, password: 'fixture', rememberMe: false })
      return Response.json({}, { headers: { 'set-cookie': 'session=fixture; HttpOnly' } })
    }
    if (path.endsWith('/api/auth/get-session')) return Response.json({ user: { id: OWNER, email: EMAIL } })
    if (path.endsWith('/api/auth/sign-out')) { events.push('signed-out'); return Response.json({}) }
    assert.ok(init.headers.cookie.includes('session=fixture'))
    if (path.endsWith('/api/workspace')) {
      const selected = url.searchParams.get('workspace') ?? (/mikka-workspace=([^;]+)/.exec(init.headers.cookie)?.[1] ?? PERSONAL)
      return Response.json({ currentUserId: OWNER, workspace: { id: selected, kind: selected === TEAM ? 'team' : 'personal' },
        role: selected === TEAM ? 'member' : 'admin', choices: [{ id: PERSONAL, kind: 'personal' }, { id: TEAM, kind: 'team' }],
        members: selected === TEAM ? [{ userId: ADMIN, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] : [] })
    }
    if (path.endsWith('/api/bots/' + RUN)) return Response.json({ id: RUN, name: '测试1505 candidate fixture' })
    if (path.endsWith('/api/devices/enrollment')) return Response.json({ token: 'fixture-one-use' })
    const { action, args } = JSON.parse(init.body)
    if (action === 'workspace.switchWorkspace') {
      if (args[0] === PERSONAL) {
        events.push('restored-workspace')
        if (failRestore) throw Error('private restore failure')
      }
      return Response.json({ version: 1, ok: true, result: { ok: true, data: { workspaceId: args[0] } } }, { headers: { 'set-cookie': 'mikka-workspace=' + args[0] + '; Path=/' } })
    }
    if (action === 'bots.createBot') { events.push('created-bot'); return Response.json({ ok: true, result: { id: RUN } }) }
    if (action === 'agents.listAgents') return Response.json({ ok: true, result: [{ id: RUN, deviceId: DEVICE, harness: devices.at(-1) }] })
    if (action === 'agents.removeDevice') {
      assert.deepEqual(args, [DEVICE]); events.push('removed')
      if (cleanupFailure) throw Error(cleanupFailure)
      return Response.json({ ok: true, result: { id: DEVICE } })
    }
    assert.fail('unexpected action')
  }
  const sandboxFactory = async template => {
    const harness = template.endsWith('claude') ? 'claude_code' : 'codex'
    devices.push(harness); events.push(`created-${harness}`)
    return {
      files: { read: async () => WORKER, write: async () => {} },
      commands: { run: async (_, options) => {
        if (options.background) {
          options.onStdout(`mikka-template-device ${JSON.stringify({ ...proof, harness,
            binary: harness === 'codex' ? '/usr/local/lib/node_modules/@openai/codex/bin/codex.js' : '/usr/local/bin/claude',
            ...proofOverride })}\n`)
          return { wait: () => new Promise(() => {}) }
        }
        return { exitCode: 0 }
      } },
      kill: async () => { events.push(`killed-${harness}`); if (cleanupFailure) throw Error(cleanupFailure) },
    }
  }
  return { events, options: { fetchImpl, sandboxFactory,
    env: { GITHUB_SHA: COMMIT, SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: 'fixture' },
    runAcceptance: async options => {
      assert.equal(options.minToolCalls, 1)
      assert.equal(options.workspace, TEAM); assert.equal(options.botId, RUN)
      assert.equal(options.runtimeEvidence, 'required')
      assert.equal(options.officialTiming, 'enabled')
      events.push(`tested-${options.harness}`)
      return runAcceptance(options)
    },
  } }
}

test('a failed subscription still tests the other candidate and closes every created instance and device', async () => {
  const fixture = candidateFixture(async options => {
    if (options.harness === 'claude_code') throw Error('fixture provider blocked')
    return accepted(options.harness)
  })
  await assert.rejects(validateTemplateSubscriptions(report, fixture.options), /template_gate_subscription_or_cleanup_failed/)
  assert.deepEqual(fixture.events, ['created-bot', 'created-claude_code', 'tested-claude_code', 'removed', 'killed-claude_code',
    'created-codex', 'tested-codex', 'removed', 'killed-codex', 'restored-workspace', 'signed-out'])
})

test('candidate acceptance is pinned to the outer SMOKE/team payer and always closes its normal session', async () => {
  for (const failRestore of [false, true]) {
    const fixture = candidateFixture(async options => {
      const result = accepted(options.harness)
      result.samples[0].execution.sharedScope.payerHash = 'c'.repeat(16)
      return result
    }, undefined, { failRestore })
    await assert.rejects(validateTemplateSubscriptions(report, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    assert.equal(fixture.events.filter(event => event === 'created-bot').length, 1)
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
  }
})

test('a real receipt rejection persists its run hash and reason without provider text or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'template-gate-diagnostics-'))
  const secret = 'sensitive_provider_token_and_reply'
  try {
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness)
      if (options.harness === 'claude_code') {
        delete value.samples[0].runtimeTiming.agentAccepted
        value.samples[0].error = `startup_${secret}`
        value.samples[0].providerText = secret
        value.cause = { message: secret, token: secret }
      }
      return value
    })
    const input = join(root, 'candidate.json'), output = join(root, 'accepted.json'), diagnostics = join(root, 'diagnostics.json')
    await writeFile(input, JSON.stringify({ ...report, ignoredSecret: secret }))
    await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    const raw = await readFile(diagnostics, 'utf8'), value = JSON.parse(raw)
    assert.equal(value.status, 'failed')
    assert.equal(value.code, 'template_gate_subscription_or_cleanup_failed')
    const { candidateProof, ...failed } = value.candidates[0]
    assert.deepEqual(failed, { kind: 'claude', stage: 'receipt', code: 'template_gate_official_agent_acceptance_missing',
      runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16),
      sampleStatus: 'execution_proved_awaiting_server_timing', sampleError: 'startup_failed', cleanupErrors: [],
      observation: { lastStatus: 'unavailable', agentStart: false, providerChunk: false,
        agentStartStage: null, cliInit: null,
        replyVerified: true, replyVerifiedAfterTool: true, successfulTool: true, runtimeTimingStatus: 'unavailable', expectedAgentAck: false,
        runtimeEvidence: { status: 'unavailable', reason: 'official_agent_acceptance_missing' } } })
    assert.equal(value.candidates[1].code, 'passed')
    assert.equal(candidateProof.deviceId, DEVICE)
    assert.equal(candidateProof.binary, '/usr/local/bin/claude')
    for (const forbidden of [secret, 'session=fixture', 'fixture-one-use', 'providerText', 'cause']) assert.ok(!raw.includes(forbidden))
    for (const id of [RUN, DEVICE]) assert.ok(!JSON.stringify(failed).includes(id))
    await assert.rejects(stat(output), { code: 'ENOENT' })
    assert.equal((await stat(diagnostics)).mode & 0o777, 0o600)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failure diagnostics retain only fixed cleanup outcomes and unknown exceptions become a generic code', async () => {
  const diagnostics = [], secret = 'template_gate_private_credential_should_never_escape'
  const fixture = candidateFixture(async options => {
    if (options.harness === 'claude_code') throw Error(secret, { cause: Error('raw provider reply') })
    const value = accepted(options.harness)
    value.samples[0].status = 'failed'
    value.samples[0].error = 'startup_execution_timeout'
    value.samples[0].issueId = '10000000-0000-4000-8000-000000000003'
    value.samples[0].cleanup = { status: 'failed', errors: [{ step: secret, code: secret }, { step: 'runStopped', code: 'startup_cleanup_terminal_timeout' }],
      retainedFixture: { issueId: value.samples[0].issueId, runIds: [RUN, RUN], token: secret } }
    return value
  }, secret)
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }), /template_gate_subscription_or_cleanup_failed/)
  const { candidateProof, ...failed } = diagnostics[0]
  assert.deepEqual(failed, { kind: 'claude', stage: 'acceptance', code: 'template_gate_failed',
    runIdHash: null, sampleStatus: 'unavailable', sampleError: null, cleanupErrors: ['device_remove_failed', 'sandbox_kill_failed'],
    cleanupFailures: [{ step: 'device_remove', code: 'startup_request_failed' }, { step: 'sandbox_kill', code: 'failed' }],
    cleanupFailuresTruncated: false, registeredDeviceId: DEVICE })
  assert.equal(candidateProof.harness, 'claude_code')
  assert.equal(candidateProof.binarySha256, 'c'.repeat(64))
  assert.equal(diagnostics[1].code, 'template_gate_execution_failed')
  assert.equal(diagnostics[1].sampleError, 'startup_execution_timeout')
  assert.deepEqual(diagnostics[1].cleanupErrors, ['device_remove_failed', 'sandbox_kill_failed', 'acceptance_cleanup_failed', 'terminal_timeout'])
  assert.deepEqual(diagnostics[1].retainedFixture, { issueId: '10000000-0000-4000-8000-000000000003', runIds: [RUN] })
  assert.equal(diagnostics[1].registeredDeviceId, DEVICE)
  assert.ok(!JSON.stringify(diagnostics).includes(secret))
  assert.ok(!JSON.stringify(diagnostics).includes('raw provider reply'))
  assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
})

test('retained cleanup identities must belong to this case and contain at most four distinct UUIDs', async () => {
  const issueId = '10000000-0000-4000-8000-000000000003'
  for (const retainedFixture of [
    { issueId: DEVICE, runIds: [RUN] },
    { issueId, runIds: [RUN, 'raw-private-token'] },
    { issueId, runIds: Array.from({ length: 5 }, (_, index) => `10000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`) },
  ]) {
    const diagnostics = []
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness)
      value.samples[0].issueId = issueId
      value.samples[0].cleanup = { status: 'failed', errors: [], retainedFixture }
      return value
    })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
    assert.ok(diagnostics.every(row => !Object.hasOwn(row, 'retainedFixture')))
    assert.ok(!JSON.stringify(diagnostics).includes('raw-private-token'))
  }
})

test('a terminal-before-proof failure identifies only its owned case and the missing evidence', async () => {
  const diagnostics = [], issueId = '10000000-0000-4000-8000-000000000003'
  const fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    if (options.harness === 'codex') Object.assign(value.samples[0], {
      issueId, placement: { kind: 'device', deviceId: DEVICE }, lastStatus: 'failed',
      status: 'failed', error: 'startup_ended_before_execution_proof',
      agentStart: { observedAt: '2026-11-07T04:26:00Z' }, firstProviderChunk: { type: 'text-delta' },
      replyVerified: false, replyVerifiedAfterTool: false, toolCalls: [{ outcome: 'error' }],
      runtimeTimingStatus: 'complete',
    })
    return value
  })
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
    /template_gate_subscription_or_cleanup_failed/)
  const failed = diagnostics.find(row => row.kind === 'codex')
  assert.deepEqual(failed.fixture, { issueId, runId: RUN })
  assert.deepEqual(failed.observation, {
    lastStatus: 'failed', agentStart: true, providerChunk: true, replyVerified: false,
    agentStartStage: null, cliInit: null,
    replyVerifiedAfterTool: false, successfulTool: false, runtimeTimingStatus: 'complete', expectedAgentAck: true,
    runtimeEvidence: { status: 'passed', reason: null },
  })
})

test('cleanup failures retain bounded step families and HTTP status without arbitrary causes', async () => {
  const diagnostics = [], secret = 'private_token_or_provider_reply'
  const fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    value.samples[0].cleanup = { status: 'failed', errors: [
      { step: 'factoryCancelled', code: 'startup_http_409', message: secret },
      { step: `runStopped_${RUN}`, code: 'startup_cleanup_scope_mismatch' },
      { step: secret, code: `startup_${secret}` },
    ] }
    value.cleanup.errors = [{ step: 'profile_archive', code: 'startup_http_500', cause: secret },
      { step: 'workspace_restore', code: 'startup_workspace_restore_failed' }]
    return value
  }, secret)
  const fetchImpl = fixture.options.fetchImpl
  fixture.options.fetchImpl = (input, init) => new URL(input).pathname.endsWith('/api/rpc')
    && JSON.parse(init.body).action === 'agents.removeDevice'
    ? Response.json({ error: secret }, { status: 409 }) : fetchImpl(input, init)
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
  assert.deepEqual(diagnostics[1].cleanupFailures, [
    { step: 'factory_cancel', code: 'http_error', httpStatus: 409 },
    { step: 'run_stop', code: 'startup_cleanup_scope_mismatch' },
    { step: 'unknown', code: 'failed' },
    { step: 'profile_archive', code: 'http_error', httpStatus: 500 },
    { step: 'workspace_restore', code: 'startup_workspace_restore_failed' },
    { step: 'device_remove', code: 'http_error', httpStatus: 409 },
    { step: 'sandbox_kill', code: 'failed' },
  ])
  assert.equal(diagnostics[1].cleanupFailuresTruncated, false)
  assert.ok(!JSON.stringify(diagnostics).includes(secret))
})

test('a failed pair preserves the genuine passing receipt without creating publishable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'template-gate-partial-proof-')), secret = 'private_provider_reply'
  try {
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness)
      value.samples[0].providerText = secret
      value.samples[0].credentials = { token: secret }
      if (options.harness === 'codex') {
        value.samples[0].status = 'failed'
        value.samples[0].error = 'startup_ended_before_execution_proof'
      }
      return value
    })
    const input = join(root, 'candidate.json'), output = join(root, 'accepted.json'), diagnostics = join(root, 'diagnostics.json')
    await writeFile(input, JSON.stringify(report))
    await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    const raw = await readFile(diagnostics, 'utf8'), value = JSON.parse(raw)
    assert.equal(value.status, 'failed')
    assert.equal(value.candidates.length, 2)
    const passing = value.candidates.find(row => row.kind === 'claude').passedReceipt
    assert.equal(passing.status, 'passed')
    assert.equal(passing.sourceCommit, COMMIT)
    assert.equal(passing.workerSha, WORKER)
    assert.equal(passing.templateId, 'candidate-claude')
    assert.equal(passing.officialBinarySha256, 'c'.repeat(64))
    assert.equal(passing.officialCliVersion, '0.163.0')
    assert.equal(passing.model, 'claude-haiku-5-5')
    assert.equal(passing.agentAcceptance.kind, 'claude_user_ack')
    assert.equal(passing.runtimeAuthorization.extraRemoteCalls, 0)
    assert.equal(passing.runtimeAuthorization.allFirstPartyHttpComplete, false)
    assert.equal(passing.replyVerifiedAfterTool, true)
    assert.ok(!Object.hasOwn(value.candidates.find(row => row.kind === 'codex'), 'passedReceipt'))
    assert.ok(!raw.includes(secret))
    assert.ok(!raw.includes('credentials'))
    await assert.rejects(stat(output), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failure projection bounds cleanup rows and refuses foreign or malformed fixture identities', async () => {
  const secret = 'private_message_must_not_become_a_field', issueId = '10000000-0000-4000-8000-000000000003'
  for (const mutate of [
    sample => { sample.sourceCommit = 'f'.repeat(40) },
    sample => { sample.placement.deviceId = RUN },
    sample => { sample.harness = 'foreign' },
    sample => { sample.issueId = secret },
    sample => { sample.runId = secret },
  ]) {
    const diagnostics = []
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness), sample = value.samples[0]
      Object.assign(sample, { issueId, placement: { kind: 'device', deviceId: DEVICE }, status: 'failed',
        lastStatus: secret, runtimeTimingStatus: secret, error: `startup_${secret}`,
        stages: [{ stage: 'agent_start', ok: secret, ms: secret }],
        daemonStartupTiming: { version: 1, runIdHash: sample.runtimeTiming.runIdHash, harness: options.harness, truncated: false,
          phases: [{ name: 'daemon.adapter.cli_init', outcome: secret, ms: secret }] },
        cleanup: { status: 'failed', errors: Array.from({ length: 100 }, () => ({ step: secret, code: secret })) } })
      value.passedReceipt = { token: secret }
      mutate(sample)
      return value
    })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
    for (const row of diagnostics) {
      assert.ok(!Object.hasOwn(row, 'fixture'))
      assert.ok(!Object.hasOwn(row, 'passedReceipt'))
      assert.equal(row.cleanupFailures.length, 8)
      assert.equal(row.cleanupFailuresTruncated, true)
      assert.equal(row.observation.lastStatus, 'unavailable')
      assert.equal(row.observation.runtimeTimingStatus, 'unavailable')
      assert.equal(row.observation.agentStartStage, null)
      assert.equal(row.observation.cliInit, null)
    }
    assert.ok(!JSON.stringify(diagnostics).includes(secret))
  }
})

test('the observed Codex adapter-start failure retains false agent_start and error cli_init', async () => {
  const diagnostics = []
  const fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    if (options.harness !== 'codex') return value
    const sample = value.samples[0], runIdHash = createHash('sha256').update(RUN).digest('hex').slice(0, 16)
    const finish = sample.runtimeTiming
    delete finish.agentAccepted
    Object.assign(finish, { executionStartMs: null, executionEndMs: null, providerOutputChunks: 0,
      toolCallsStarted: 0, toolCallsCompleted: 0, toolCallsFailed: 0 })
    finish.officialCliTiming.events = []
    Object.assign(finish.mcpHttpTiming, { observedChildren: 0, observedComplete: false, children: [], requests: [] })
    delete sample.runtimeTiming
    Object.assign(sample, { runIdHash, status: 'failed', error: 'startup_ended_before_execution_proof',
      replyVerified: false, replyVerifiedAfterTool: false, toolCalls: [] })
    const stage = data => ({ chunk: { type: 'data-run-stage', data } })
    assert.equal(observeChunks(sample, { thread: { id: RUN, status: 'failed' }, chunks: [
      stage({ stage: 'repository', ok: true, ms: 4609 }), stage({ stage: 'worktree', ok: true, ms: 69 }),
      stage({ stage: 'agent_start', ok: false, ms: 459, startupTiming: {
        version: 1, runIdHash, harness: 'codex', startedAt: 1794025606249, endedAt: 1794025606708,
        ms: 459.145, outcome: 'error', truncated: false, phases: [
          { name: 'daemon.adapter.model_report', startMs: 2.115, endMs: 2.392, ms: 0.277, outcome: 'ok' },
          { name: 'daemon.adapter.cli_init', startMs: 14.859, endMs: 455.88, ms: 441.021, outcome: 'error' },
        ],
      } }),
      { chunk: { type: 'finish', messageMetadata: { mikkaRuntimeTiming: finish } } },
      { chunk: { type: 'data-run-state', data: { state: 'failed', stopReason: 'error',
        error: 'subscription_hosted_runtime_unavailable (adapter_start_failed)' } } },
    ] }, 1794025608000), false)
    return value
  })
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
  const failed = diagnostics.find(row => row.kind === 'codex')
  assert.deepEqual(failed.observation.agentStartStage, { ok: false, ms: 459 })
  assert.deepEqual(failed.observation.cliInit, { outcome: 'error', ms: 441.021 })
  assert.equal(failed.observation.agentStart, false)
  assert.equal(failed.observation.providerChunk, false)
  assert.equal(failed.observation.expectedAgentAck, false)
  assert.equal(failed.observation.runtimeTimingStatus, 'complete')
  assert.deepEqual(failed.observation.runtimeEvidence, { status: 'unavailable', reason: 'runtime_receipt_incomplete' })
  assert.equal(failed.sampleError, 'startup_ended_before_execution_proof')
})

test('failed execution retains only bound registration binary metadata without a passing receipt', async () => {
  const diagnostics = [], secret = 'private_registration_field'
  const fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    if (options.harness === 'codex') {
      value.samples[0].status = 'failed'
      value.samples[0].error = 'startup_ended_before_execution_proof'
    }
    return value
  }, undefined, { proofOverride: { privateField: secret } })
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
  const failed = diagnostics.find(row => row.kind === 'codex')
  assert.deepEqual(failed.candidateProof, { sourceCommit: COMMIT, workerSha: WORKER, templateId: 'candidate-codex',
    harness: 'codex', deviceId: DEVICE, binary: '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    binarySha256: 'c'.repeat(64), version: '0.163.0' })
  assert.equal(failed.code, 'template_gate_execution_failed')
  assert.ok(!Object.hasOwn(failed, 'passedReceipt'))
  assert.ok(!JSON.stringify(diagnostics).includes(secret))
})

test('registration diagnostics reject unbounded or non-original binary metadata without leaking it', async () => {
  const secret = 'private_registration_value'
  for (const proofOverride of [
    { binary: `https://example.invalid/${secret}` },
    { binary: `/usr/local/bin/../${secret}` },
    { binary: '/opt/mikka/runtime/harness-bin/codex' },
    { binary: `/usr/local/bin/codex\n${secret}` },
    { binary: '/usr/local/bin/' + 'x'.repeat(1024) },
    { version: secret },
  ]) {
    const diagnostics = []
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness)
      if (options.harness === 'codex') {
        value.samples[0].status = 'failed'
        value.samples[0].error = 'startup_ended_before_execution_proof'
      }
      return value
    }, undefined, { proofOverride })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }))
    assert.ok(diagnostics.every(row => !Object.hasOwn(row, 'candidateProof')))
    if (proofOverride.version) assert.ok(diagnostics.every(row => !Object.hasOwn(row, 'passedReceipt')))
    assert.ok(!JSON.stringify(diagnostics).includes(secret))
  }
})
