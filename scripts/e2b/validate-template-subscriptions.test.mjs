import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateReceipt, validateTemplateSubscriptions, validateSubscriptionFiles } from './validate-template-subscriptions.mjs'
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

function candidateFixture(runAcceptance, cleanupFailure, { failRestore = false } = {}) {
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
          options.onStdout(`mikka-template-device ${JSON.stringify({ ...proof, harness })}\n`)
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
    assert.deepEqual(value.candidates[0], { kind: 'claude', stage: 'receipt', code: 'template_gate_official_agent_acceptance_missing',
      runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16),
      sampleStatus: 'execution_proved_awaiting_server_timing', sampleError: 'startup_failed', cleanupErrors: [] })
    assert.equal(value.candidates[1].code, 'passed')
    for (const forbidden of [secret, RUN, DEVICE, 'session=fixture', 'fixture-one-use', 'providerText', 'cause']) assert.ok(!raw.includes(forbidden))
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
  assert.deepEqual(diagnostics[0], { kind: 'claude', stage: 'acceptance', code: 'template_gate_failed',
    runIdHash: null, sampleStatus: 'unavailable', sampleError: null, cleanupErrors: ['device_remove_failed', 'sandbox_kill_failed'], registeredDeviceId: DEVICE })
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
