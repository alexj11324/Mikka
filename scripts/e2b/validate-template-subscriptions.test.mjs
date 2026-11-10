import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateReceipt, validateTemplateSubscriptions, validateSubscriptionFiles } from './validate-template-subscriptions.mjs'
import { observeChunks, bootstrapAdoptionEvidence, bootstrapAdoptionDiagnostics } from '../acceptance/cloud-startup.mjs'
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
const candidateProjection = harness => ({ version: 1, authority: 'none', deviceId: DEVICE, workspaceId: TEAM, harness,
  hint: { runId: RUN, bootstrapSha256: '1'.repeat(64), diagnostics: true, model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5' } })
const bootstrapReceipt = harness => ({ version: 1, runId: RUN, harness, bootstrapSha256: '1'.repeat(64),
  hintSha256: hash(JSON.stringify(candidateProjection(harness).hint)) })
const proof = { deviceId: DEVICE, workspaceId: TEAM, binarySha256: 'c'.repeat(64), version: '0.163.0',
  bootstrapSha256: '1'.repeat(64), registrationMode: 'cloud_worker_bootstrap' }
const bootstrapTiming = harness => {
  const base = { version: 1, runIdHash: hash(RUN).slice(0, 16), harness, truncated: false, outcome: 'ok' }
  return {
    bootstrapPublication: bootstrapReceipt(harness),
    startupTimingStatus: 'complete', preparationTimingStatus: 'complete',
    daemonStartupTiming: { ...base, startedAt: 1200, endedAt: 1600, ms: 400, phases: [] },
    daemonPreparationTiming: { ...base, startedAt: 1000, endedAt: 1500, ms: 500,
      source: harness === 'codex' ? 'bootstrap_codex_initialize' : 'bootstrap_claude_start',
      ...(harness === 'claude_code' ? { claimAuthentication: 'oauth_environment', observedAuthSource: 'oauth_environment' } : {}),
      phases: [{ name: 'daemon.adapter.cli_init.prewarm', startMs: 0, endMs: 300, ms: 300, outcome: 'ok' },
        { name: 'daemon.adapter.cli_init', startMs: 490, endMs: 500, ms: 10, outcome: 'ok' }] },
  }
}
const accepted = harness => ({ mode: 'candidate', status: 'candidate_subscription_proved', accountHash: hash(OWNER).slice(0, 16), team,
  cleanup: { errors: [], workspaceRestored: true }, officialTiming: { enabled: true, cleaned: true }, samples: [{
  status: 'execution_proved_awaiting_server_timing', sourceCommit: COMMIT, harness, runId: RUN, ...bootstrapTiming(harness),
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
  const workflow = await readFile(new URL('../../.github/workflows/e2b-runtime-release.yml', import.meta.url), 'utf8')
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
  const receipt = candidateReceipt(report, 'codex', { ...proof, bootstrapReceipt: bootstrapReceipt('codex') }, accepted('codex'))
  assert.deepEqual(receipt, { status: 'passed', templateId: 'candidate-codex', sourceCommit: COMMIT, workerSha: WORKER,
    harness: 'codex', model: 'gpt-6-luna', credentialRoute: 'subscription', replyVerified: true, runId: RUN,
    replyVerifiedAfterTool: true, toolEvidence: { toolCallHash: 'd'.repeat(16), outcome: 'ok' },
    deviceId: DEVICE, officialBinarySha256: proof.binarySha256, officialCliVersion: proof.version,
    sharedScope,
    bootstrapAcceptance: { ...bootstrapAdoptionEvidence({ ...accepted('codex').samples[0], runIdHash: hash(RUN).slice(0, 16) }),
      bootstrapSha256: proof.bootstrapSha256, hintSha256: bootstrapReceipt('codex').hintSha256 },
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

function candidateFixture(runAcceptance, cleanupFailure, { failRestore = false, proofOverride = {}, queueRun = () => true } = {}) {
  const events = [], devices = [], observations = { publications: 0, proofReads: 0 }
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
    if (path.endsWith('/api/runs/' + RUN + '/evidence')) {
      assert.equal(url.searchParams.get('bootstrap'), '1')
      assert.equal(url.searchParams.get('deviceId'), DEVICE)
      assert.equal(url.searchParams.get('workspaceId'), TEAM)
      assert.equal(url.searchParams.get('bootstrapSha256'), proof.bootstrapSha256)
      return Response.json({ bootstrap: candidateProjection(devices.at(-1)) })
    }
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
    let stagedProjection, published = false
    devices.push(harness); events.push(`created-${harness}`)
    return {
      files: {
        read: async path => {
          if (!path.endsWith('bootstrap-proof.json')) return WORKER
          observations.proofReads++
          if (!published) throw Object.assign(Error('fixture bootstrap was not published'), { code: 'ENOENT' })
          return JSON.stringify(bootstrapReceipt(harness))
        },
        write: async (path, raw) => {
          if (path.endsWith('start.json')) {
            stagedProjection = JSON.parse(raw)
            assert.deepEqual(stagedProjection, candidateProjection(harness))
          }
        },
      },
      commands: { run: async (command, options) => {
        if (options.background) {
          options.onStdout(`mikka-template-device ${JSON.stringify({ ...proof, harness,
            binary: harness === 'codex' ? '/usr/local/lib/node_modules/@openai/codex/bin/codex.js' : '/usr/local/bin/claude',
            ...proofOverride })}\n`)
          return { wait: () => new Promise(() => {}) }
        }
        if (command.includes('/home/user/.mikka/template-acceptance/start.next')) {
          assert.deepEqual(stagedProjection, candidateProjection(harness))
          published = true; observations.publications++
        }
        return { exitCode: 0 }
      } },
      kill: async () => { events.push(`killed-${harness}`); if (cleanupFailure) throw Error(cleanupFailure) },
    }
  }
  return { events, observations, options: { fetchImpl, sandboxFactory,
    env: { GITHUB_SHA: COMMIT, SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: 'fixture' },
    runAcceptance: async (options, dependencies) => {
      assert.equal(options.minToolCalls, 1)
      assert.equal(options.workspace, TEAM); assert.equal(options.botId, RUN)
      assert.equal(options.runtimeEvidence, 'required')
      assert.equal(options.officialTiming, 'enabled')
      if (queueRun(options.harness)) {
        const published = await dependencies.onCandidateRunQueued({ runId: RUN, issueId: RUN, deviceId: DEVICE,
          agentId: RUN, workspaceId: TEAM, harness: options.harness,
          model: options.harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5' })
        assert.deepEqual(published, bootstrapReceipt(options.harness))
      }
      events.push(`tested-${options.harness}`)
      return runAcceptance(options)
    },
  } }
}

const startupTrace = '0123456789abcdef0123456789abcdef'
const startupTraceScope = 'submission_http_only_workflow_may_use_another_trace'
const startupWorkflow = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE'
const preRunFailure = (harness, code, extra = {}) => ({
  sourceCommit: COMMIT, harness, status: 'failed', error: code,
  failure: { phase: 'coordinator_stream', code }, cleanup: { status: 'passed', errors: [] },
  requestTraceId: startupTrace, requestTraceScope: startupTraceScope, workflowRunId: startupWorkflow,
  ...extra,
})

/** Exercise the public failure-file seam without publishing a bootstrap for a run that never bound. */
async function preRunFailureArtifact(sample, harness = 'claude_code') {
  const root = await mkdtemp(join(tmpdir(), 'template-gate-correlation-'))
  try {
    const fixture = candidateFixture(async options => accepted(options.harness))
    const run = fixture.options.runAcceptance, create = fixture.options.sandboxFactory
    fixture.options.runAcceptance = async (options, dependencies) => {
      assert.equal(options.timeoutMs, 240000)
      if (options.harness !== harness) return run(options, dependencies)
      return { mode: 'candidate', status: 'failed', cleanup: { errors: [] }, samples: [sample] }
    }
    fixture.options.sandboxFactory = async (template, options) => {
      const sandbox = await create(template, options), read = sandbox.files.read
      if (template.endsWith(harness === 'claude_code' ? 'claude' : 'codex')) sandbox.files.read = path => {
        if (path.endsWith('bootstrap-proof.json')) throw Object.assign(new Error('private missing bootstrap path'), { code: 'ENOENT' })
        return read(path)
      }
      return sandbox
    }
    const input = join(root, 'candidate.json'), output = join(root, 'accepted.json'), diagnostics = join(root, 'diagnostics.json')
    await writeFile(input, JSON.stringify(report))
    await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    const raw = await readFile(diagnostics, 'utf8'), value = JSON.parse(raw)
    const kind = harness === 'claude_code' ? 'claude' : 'codex'
    const failed = value.candidates.find(row => row.kind === kind), passed = value.candidates.find(row => row.kind !== kind)
    assert.equal(value.status, 'failed')
    assert.equal(failed.code, 'template_gate_execution_failed')
    assert.equal(failed.stage, 'acceptance')
    assert.deepEqual(fixture.observations, { publications: 1, proofReads: 1 })
    assert.equal(failed.runIdHash, null)
    assert.equal(passed.passedReceipt.status, 'passed')
    assert.ok(!Object.hasOwn(passed, 'startupCorrelation'))
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
    assert.ok(fixture.events.includes('restored-workspace') && fixture.events.includes('signed-out'))
    await assert.rejects(stat(output), { code: 'ENOENT' })
    assert.equal((await stat(diagnostics)).mode & 0o777, 0o600)
    return { raw, failed }
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const [harness, code, dispatchRefusal] of [
  ['claude_code', 'startup_dispatch_refused', { code: 'githubNotConnected' }],
  ['codex', 'startup_timeout', null],
]) test(`startup correlation survives ${harness} failure before a run exists`, async () => {
  const { failed } = await preRunFailureArtifact(preRunFailure(harness, code, { dispatchRefusal }), harness)
  assert.deepEqual(failed.failure, { phase: 'coordinator_stream', code })
  assert.deepEqual(failed.startupCorrelation, {
    requestTraceId: startupTrace, requestTraceScope: startupTraceScope,
    workflowRunId: startupWorkflow, dispatchRefusal,
  })
})

test('startup correlation requires exact candidate binding and existing metadata', async () => {
  for (const extra of [
    { sourceCommit: 'f'.repeat(40) }, { sourceCommit: undefined }, { sourceCommit: { value: COMMIT } },
    { harness: 'codex' }, { harness: undefined }, { harness: ['claude_code'] },
    { requestTraceId: undefined, workflowRunId: undefined, dispatchRefusal: undefined },
  ]) {
    const { raw, failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_dispatch_refused', {
      dispatchRefusal: { code: 'githubNotConnected' }, ...extra,
    }))
    assert.ok(!Object.hasOwn(failed, 'startupCorrelation'))
    assert.ok(!raw.includes(startupTrace) && !raw.includes(startupWorkflow))
    assert.equal(failed.sampleError, 'startup_dispatch_refused')
  }
})

test('startup correlation rejects malformed identifiers and preserves independently valid fields', async () => {
  let coercions = 0
  const nonString = { toString() { coercions++; return startupTrace } }
  for (const requestTraceId of [undefined, null, 1, true, [], nonString, '0'.repeat(32), 'f'.repeat(31),
    'F'.repeat(32), `${startupTrace}\n`, 'private-canary@example.invalid']) {
    const { failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_timeout', { requestTraceId }))
    assert.deepEqual(failed.startupCorrelation, {
      requestTraceId: null, requestTraceScope: null, workflowRunId: startupWorkflow, dispatchRefusal: null,
    })
  }
  for (const workflowRunId of [undefined, null, 1, nonString, 'wrun_', `wrun_${'a'.repeat(129)}`,
    `${startupWorkflow}\n`, `${startupWorkflow}/private`, 'wrun_private-canary@example.invalid']) {
    const { failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_timeout', { workflowRunId }))
    assert.equal(failed.startupCorrelation.workflowRunId, null)
    assert.equal(failed.startupCorrelation.requestTraceId, startupTrace)
  }
  for (const workflowRunId of ['wrun_legacy1', `wrun_${'a'.repeat(128)}`]) {
    const { failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_timeout', { workflowRunId }))
    assert.equal(failed.startupCorrelation.workflowRunId, workflowRunId)
  }
  const { failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_timeout', {
    requestTraceScope: 'private_scope_or_run_trace_claim',
  }))
  assert.equal(failed.startupCorrelation.requestTraceId, null)
  assert.equal(failed.startupCorrelation.requestTraceScope, null)
  assert.equal(coercions, 0)
})

test('startup correlation keeps only closed refusal codes and never emits prompts or other identities', async () => {
  const secret = 'PRIVATE_PROMPT_RESPONSE_CREDENTIAL_CANARY', privateId = '90000000-0000-4000-8000-000000000009'
  for (const code of ['githubNotConnected', 'deviceNotFound', 'machineUnavailable', 'agentProfilePinConflict', 'factorySourceMismatch',
    'githubNotConnected_PRIVATE_CANARY', 'private-canary@example.invalid', '__proto__', 'constructor', 503, { private: secret }]) {
    const expected = ['githubNotConnected', 'deviceNotFound', 'machineUnavailable', 'agentProfilePinConflict', 'factorySourceMismatch'].includes(code) ? code : 'unknown'
    const { raw, failed } = await preRunFailureArtifact(preRunFailure('claude_code', 'startup_dispatch_refused', {
      dispatchRefusal: { code, detail: secret, message: secret, raw: secret, userId: privateId },
      prompt: secret, providerText: secret, issueId: privateId, botId: privateId,
      dispatchCallId: privateId, stepId: privateId, cookie: secret,
    }))
    assert.deepEqual(failed.startupCorrelation, {
      requestTraceId: startupTrace, requestTraceScope: startupTraceScope,
      workflowRunId: startupWorkflow, dispatchRefusal: { code: expected },
    })
    for (const forbidden of [secret, privateId, 'private-canary@example.invalid', 'githubNotConnected_PRIVATE_CANARY']) assert.ok(!raw.includes(forbidden))
  }
})

test('successful candidate diagnostics do not gain startup correlation metadata', async () => {
  const diagnostics = [], fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    Object.assign(value.samples[0], { requestTraceId: startupTrace, requestTraceScope: startupTraceScope,
      workflowRunId: startupWorkflow, dispatchRefusal: { code: 'githubNotConnected' } })
    return value
  })
  await validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) })
  assert.equal(diagnostics.length, 2)
  assert.ok(diagnostics.every(row => row.code === 'passed' && !Object.hasOwn(row, 'startupCorrelation')))
})

test('a pre-dispatch refusal keeps its phase without reading an unpublished proof and cleans both candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'template-gate-dispatch-'))
  const failure = { phase: 'coordinator_stream', code: 'startup_dispatch_refused' }
  const fixture = candidateFixture(async options => ({ mode: 'candidate', status: 'failed', cleanup: { errors: [] }, samples: [{
    harness: options.harness, status: 'failed', error: failure.code, failure,
    dispatchRefusal: { code: 'deviceNotFound' }, cleanup: { status: 'passed', errors: [] },
  }] }), undefined, { queueRun: () => false })
  try {
    const input = join(root, 'candidate.json'), output = join(root, 'accepted.json'), diagnostics = join(root, 'diagnostics.json')
    await writeFile(input, JSON.stringify(report))
    await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    const value = JSON.parse(await readFile(diagnostics, 'utf8'))
    assert.equal(value.status, 'failed'); assert.equal(value.candidates.length, 2)
    for (const row of value.candidates) {
      assert.equal(row.code, 'template_gate_execution_failed')
      assert.equal(row.stage, 'acceptance')
      assert.deepEqual(row.failure, failure)
      assert.equal(row.runIdHash, null)
      assert.deepEqual(row.cleanupErrors, [])
      assert.ok(!Object.hasOwn(row, 'passedReceipt'))
    }
    assert.deepEqual(fixture.observations, { publications: 0, proofReads: 0 })
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
    assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
    await assert.rejects(stat(output), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dispatch refusal diagnostics admit only fixed business codes and never untrusted details', async () => {
  const secret = 'PRIVATE_CREDENTIAL_LIKE_IDENTIFIER'
  const cases = [
    ...['deviceNotFound', 'agentProfilePinConflict', 'githubRepositoryForbidden', 'runInvalid'].map(code => [code, code]),
    ...[secret, 'unknownDispatchCode', 'deviceNotFound\n' + secret, 'x'.repeat(1024), null, undefined,
      403, { code: 'deviceNotFound', token: secret }].map(code => [code, 'unavailable']),
  ]
  for (const [code, expected] of cases) {
    const diagnostics = [], fixture = candidateFixture(async options => ({ mode: 'candidate', status: 'failed', cleanup: { errors: [] }, samples: [{
      harness: options.harness, status: 'failed', error: 'startup_dispatch_refused',
      failure: { phase: 'coordinator_stream', code: 'startup_dispatch_refused' },
      dispatchRefusal: { code, detail: secret, body: secret, cause: { token: secret } },
      cleanup: { status: 'passed', errors: [] },
    }] }), undefined, { queueRun: () => false })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
      /template_gate_subscription_or_cleanup_failed/)
    assert.equal(diagnostics.length, 2)
    for (const row of diagnostics) assert.deepEqual(row.dispatchRefusal, { code: expected })
    const raw = JSON.stringify(diagnostics)
    for (const forbidden of [secret, 'unknownDispatchCode', 'detail', 'body', 'cause', 'token']) assert.ok(!raw.includes(forbidden))
    assert.deepEqual(fixture.observations, { publications: 0, proofReads: 0 })
  }
})

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
    const { candidateProof, bootstrapDiagnostics, ...failed } = value.candidates[0]
    assert.equal(bootstrapDiagnostics.startupTimingStatus, 'complete')
    assert.equal(bootstrapDiagnostics.preparationTimingStatus, 'complete')
    assert.equal(bootstrapDiagnostics.bindingChecks, null)
    assert.ok(Object.values(bootstrapDiagnostics.adoptionChecks).every(Boolean))
    assert.deepEqual(failed, { kind: 'claude', stage: 'receipt', code: 'template_gate_official_agent_acceptance_missing',
      runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16),
      sampleStatus: 'execution_proved_awaiting_server_timing', sampleError: 'startup_failed', cleanupErrors: [],
      failure: { phase: 'unknown', code: 'startup_failed' },
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

test('preflight failures preserve their phase and closed error details without producing an accepted file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'template-gate-preflight-')), secret = 'private_response_and_model_text'
  const failures = [
    { phase: 'profile_create', code: 'startup_http_error', httpStatus: 403 },
    { phase: 'profile_validation', code: 'startup_http_error', httpStatus: 400 },
    { phase: 'coordinator_stream', code: 'startup_http_error', httpStatus: 599 },
    { phase: 'profile_selection', code: 'startup_api_refused' },
    { phase: 'coordinator_submit', code: 'startup_rpc_refused' },
    { phase: 'issue_create', code: 'startup_action_refused' },
    { phase: 'coordinator_stream', code: 'startup_coordinator_stream_invalid' },
    { phase: 'coordinator_stream', code: 'startup_dispatch_refused' },
    { phase: 'coordinator_stream', code: 'startup_aborted' },
    { phase: 'coordinator_stream', code: 'startup_timeout' },
    { phase: 'thread_lookup', code: 'startup_dispatch_run_missing' },
  ]
  try {
    const input = join(root, 'candidate.json')
    await writeFile(input, JSON.stringify(report))
    for (const [index, failure] of failures.entries()) {
      const fixture = candidateFixture(async options => options.harness === 'claude_code' ? accepted(options.harness) : {
        mode: 'candidate', status: 'failed', cleanup: { errors: [] }, samples: [{
          harness: options.harness, status: 'failed', error: failure.code,
          failure: { ...failure, message: secret, body: secret, cause: { token: secret } },
          providerText: secret, cleanup: { status: 'passed', errors: [] },
        }],
      }, undefined, { queueRun: harness => harness === 'claude_code' })
      const output = join(root, `accepted-${index}.json`), diagnostics = join(root, `diagnostics-${index}.json`)
      await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
      const raw = await readFile(diagnostics, 'utf8'), value = JSON.parse(raw)
      const failed = value.candidates.find(row => row.kind === 'codex')
      assert.equal(value.status, 'failed')
      assert.equal(value.code, 'template_gate_subscription_or_cleanup_failed')
      assert.equal(failed.stage, 'acceptance')
      assert.equal(failed.code, 'template_gate_execution_failed')
      assert.deepEqual(failed.failure, failure)
      assert.equal(failed.sampleError, failure.code)
      assert.equal(failed.runIdHash, null)
      assert.equal(failed.candidateProof.harness, 'codex')
      assert.ok(!Object.hasOwn(failed, 'passedReceipt'))
      assert.equal(value.candidates.find(row => row.kind === 'claude').passedReceipt.status, 'passed')
      for (const forbidden of [secret, 'providerText', 'cause', 'message', 'body']) assert.ok(!raw.includes(forbidden))
      assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
      await assert.rejects(stat(output), { code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a failure before a sample exists preserves the startup phase without inventing sample evidence', async () => {
  const diagnostics = [], failure = { phase: 'build_pin', code: 'startup_build_mismatch' }
  const fixture = candidateFixture(async options => options.harness === 'claude_code' ? accepted(options.harness) : {
    mode: 'candidate', status: 'failed', error: failure.code, failure, samples: [], cleanup: { errors: [] },
  }, undefined, { queueRun: harness => harness === 'claude_code' })
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
    /template_gate_subscription_or_cleanup_failed/)
  const failed = diagnostics.find(row => row.kind === 'codex')
  assert.deepEqual(failed.failure, failure)
  assert.equal(failed.sampleStatus, 'unavailable')
  assert.equal(failed.sampleError, null)
  assert.equal(failed.runIdHash, null)
  assert.ok(!Object.hasOwn(failed, 'observation'))
  assert.ok(!Object.hasOwn(failed, 'startupCorrelation'))
  assert.ok(!Object.hasOwn(failed, 'passedReceipt'))
})

test('startup failure projection drops unknown content and only admits numeric HTTP error statuses', async () => {
  const secret = 'private_unknown_code_phase_or_http_body'
  const cases = [
    [{ phase: secret, code: `startup_${secret}`, httpStatus: 500 }, { phase: 'unknown', code: 'startup_failed' }],
    [{ phase: secret, code: 'startup_api_refused', httpStatus: 500 }, { phase: 'unknown', code: 'startup_api_refused' }],
    ...['403', secret, 399, 600, 500.5, null].map(httpStatus => [
      { phase: 'profile_create', code: 'startup_http_error', httpStatus }, { phase: 'profile_create', code: 'startup_http_error' },
    ]),
    [undefined, { phase: 'unknown', code: 'startup_http_error', httpStatus: 503 }],
  ]
  for (const [failure, expected] of cases) {
    const diagnostics = []
    const fixture = candidateFixture(async options => options.harness === 'claude_code' ? accepted(options.harness) : {
      mode: 'candidate', status: 'failed', cleanup: { errors: [] }, samples: [{
        harness: options.harness, status: 'failed', error: failure?.code ?? 'startup_http_503',
        failure: failure && { ...failure, message: secret, response: { body: secret }, cause: { token: secret } },
        cleanup: { status: 'passed', errors: [] },
      }],
    }, undefined, { queueRun: harness => harness === 'claude_code' })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
      /template_gate_subscription_or_cleanup_failed/)
    const failed = diagnostics.find(row => row.kind === 'codex')
    assert.deepEqual(failed.failure, expected)
    assert.equal(failed.sampleError, expected.code)
    assert.ok(!Object.hasOwn(failed, 'passedReceipt'))
    const raw = JSON.stringify(diagnostics)
    for (const forbidden of [secret, 'response', 'message', 'cause', 'token']) assert.ok(!raw.includes(forbidden))
  }
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
    delete sample.daemonStartupTiming
    delete sample.daemonPreparationTiming
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

test('bootstrap adoption is required; ordinary FD3, wrong run, duplicate warmup or descriptor auth cannot publish', () => {
  for (const harness of ['claude_code', 'codex']) {
    const kind = harness === 'codex' ? 'codex' : 'claude'
    const validProof = { ...proof, bootstrapReceipt: bootstrapReceipt(harness) }
    for (const mutate of [
      sample => { delete sample.daemonPreparationTiming },
      sample => { sample.preparationTimingStatus = 'invalid' },
      sample => { sample.daemonPreparationTiming.source = 'prepared_agent_start' },
      sample => { sample.daemonPreparationTiming.runIdHash = '0'.repeat(16) },
      sample => { sample.daemonPreparationTiming.phases.push({ ...sample.daemonPreparationTiming.phases[0] }) },
      sample => { sample.daemonPreparationTiming.phases[0].outcome = 'error' },
      sample => { delete sample.bootstrapPublication },
      sample => { sample.bootstrapPublication.runId = DEVICE },
      ...(harness === 'claude_code' ? [
        sample => { sample.daemonPreparationTiming.claimAuthentication = 'ordinary_path' },
        sample => { sample.daemonPreparationTiming.observedAuthSource = 'oauth_descriptor' },
      ] : []),
    ]) {
      const value = accepted(harness); mutate(value.samples[0])
      assert.throws(() => candidateReceipt(report, kind, validProof, value), /template_gate_bootstrap_adoption_missing/)
    }
    assert.throws(() => candidateReceipt(report, kind, proof, accepted(harness)), /template_gate_bootstrap_adoption_missing/)
  }
})

test('bootstrap projection, repeated publication and VM proof failures still reclaim both candidate devices and VMs', async () => {
  for (const reason of ['wrong-device', 'duplicate', 'vm-proof', 'missing-proof']) {
    const fixture = candidateFixture(async options => accepted(options.harness))
    const diagnostics = []
    let publications = 0
    const create = fixture.options.sandboxFactory
    fixture.options.sandboxFactory = async (...args) => {
      const sandbox = await create(...args), read = sandbox.files.read, write = sandbox.files.write
      sandbox.files.write = async (path, ...rest) => { if (path.endsWith('start.json')) publications++; return write(path, ...rest) }
      sandbox.files.read = async (path, ...rest) => {
        if (reason === 'missing-proof' && path.endsWith('bootstrap-proof.json')) throw Object.assign(Error('fixture missing proof'), { code: 'ENOENT' })
        if (reason === 'vm-proof' && path.endsWith('bootstrap-proof.json')) return JSON.stringify({ ...bootstrapReceipt('codex'), runId: DEVICE })
        return read(path, ...rest)
      }
      return sandbox
    }
    if (reason === 'wrong-device') {
      const original = fixture.options.fetchImpl
      fixture.options.fetchImpl = async (input, init) => new URL(input).pathname.endsWith('/evidence')
        ? Response.json({ bootstrap: { ...candidateProjection('codex'), deviceId: RUN } }) : original(input, init)
    }
    if (reason === 'duplicate') {
      const original = fixture.options.runAcceptance
      fixture.options.runAcceptance = async (options, dependencies) => { await original(options, dependencies); return original(options, dependencies) }
    }
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }), /template_gate_subscription_or_cleanup_failed/)
    if (reason === 'vm-proof' || reason === 'missing-proof') for (const row of diagnostics) {
      assert.equal(row.code, 'template_gate_bootstrap_proof_invalid')
      assert.ok(!Object.hasOwn(row, 'passedReceipt'))
    }
    assert.equal(publications, reason === 'wrong-device' ? 0 : 2)
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
    assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
  }
})

test('bootstrap failure diagnostics preserve existing strict timings and final binding checks without accepting the pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'template-bootstrap-failure-'))
  const secret = 'private_bootstrap_hint_token_prompt_must_not_escape'
  try {
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness), sample = value.samples[0]
      sample.lastStatus = 'succeeded'
      sample.runtimeTimingStatus = 'complete'
      sample.daemonStartupTiming.privateValue = secret
      sample.daemonPreparationTiming.privateValue = secret
      sample.daemonPreparationTiming.phases[0].command = secret
      if (options.harness === 'claude_code') {
        sample.daemonPreparationTiming.claimAuthentication = 'ordinary_path'
        sample.daemonPreparationTiming.observedAuthSource = 'oauth_descriptor'
      } else sample.preparationTimingStatus = 'invalid'
      return value
    })
    const input = join(root, 'candidate.json'), output = join(root, 'accepted.json'), diagnostics = join(root, 'diagnostics.json')
    await writeFile(input, JSON.stringify(report))
    await assert.rejects(validateSubscriptionFiles(input, output, diagnostics, fixture.options), /template_gate_subscription_or_cleanup_failed/)
    const raw = await readFile(diagnostics, 'utf8'), value = JSON.parse(raw)
    assert.equal(value.status, 'failed')
    for (const row of value.candidates) {
      assert.equal(row.stage, 'receipt')
      assert.equal(row.code, 'template_gate_bootstrap_adoption_missing')
      assert.equal(row.observation.cliInit, null)
      assert.equal(row.observation.replyVerifiedAfterTool, true)
      assert.equal(row.observation.expectedAgentAck, true)
      assert.equal(row.observation.runtimeEvidence.status, 'passed')
      const detail = row.bootstrapDiagnostics
      assert.ok(detail, 'the failed artifact must retain strict startup/preparation evidence, not only cliInit:null')
      assert.equal(detail.startupTimingStatus, 'complete')
      assert.equal(detail.preparationTimingStatus, row.kind === 'claude' ? 'complete' : 'invalid')
      assert.equal(detail.startupTiming.startedAt, 1200)
      assert.equal(detail.preparationTiming.startedAt, 1000)
      assert.equal(detail.preparationTiming.phases.length, 2)
      assert.equal(detail.projectionTruncated, false)
      assert.ok(Object.values(detail.bindingChecks).every(value => value === true))
      if (row.kind === 'claude') {
        assert.equal(detail.adoptionChecks.claimAuthentication, false)
        assert.equal(detail.adoptionChecks.observedAuthSource, false)
      } else assert.equal(detail.adoptionChecks.preparationTimingStatus, false)
      assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 32768)
    }
    assert.ok(!raw.includes(secret))
    assert.ok(!raw.includes('privateValue'))
    assert.ok(!raw.includes('command'))
    await assert.rejects(stat(output), { code: 'ENOENT' })
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
    assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('bootstrap failure timing projection rejects foreign, oversized and private values without widening adoption', () => {
  const privateValue = 'private_diagnostic_input_must_not_escape'
  const cases = [
    record => { record.startupTimingStatus = privateValue },
    record => { record.preparationTimingStatus = privateValue },
    record => { record.daemonStartupTiming.runIdHash = '0'.repeat(16) },
    record => { record.daemonPreparationTiming.harness = 'unknown-private-harness' },
    record => { record.daemonPreparationTiming.source = privateValue },
    record => { record.daemonPreparationTiming.phases = Array.from({ length: 65 }, () => ({ ...record.daemonPreparationTiming.phases[0] })) },
    record => { record.daemonPreparationTiming.phases[0].name = privateValue },
    record => { record.daemonPreparationTiming.phases[0].ms = Number.NaN },
    record => { record.daemonPreparationTiming.startedAt = record.daemonStartupTiming.startedAt + 1 },
    record => { record.daemonPreparationTiming.observedAuthSource = privateValue },
    record => { record.daemonPreparationTiming.claimAuthentication = 'ordinary_path' },
    record => { record.daemonPreparationTiming.truncated = true },
    record => { record.daemonPreparationTiming.phases.push({ ...record.daemonPreparationTiming.phases[0] }) },
  ]
  for (const mutate of cases) {
    const record = { ...accepted('claude_code').samples[0], runIdHash: hash(RUN).slice(0, 16) }
    record.daemonStartupTiming.privateValue = privateValue
    record.daemonPreparationTiming.privateValue = privateValue
    mutate(record)
    const result = bootstrapAdoptionDiagnostics(record)
    assert.equal(bootstrapAdoptionEvidence(record), null)
    assert.equal(Object.values(result.adoptionChecks).every(Boolean), false)
    assert.ok(!JSON.stringify(result).includes(privateValue))
    assert.ok(!JSON.stringify(result).includes('privateValue'))
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768)
  }
  for (const harness of ['claude_code', 'codex']) {
    const record = { ...accepted(harness).samples[0], runIdHash: hash(RUN).slice(0, 16) }
    const result = bootstrapAdoptionDiagnostics(record)
    assert.ok(bootstrapAdoptionEvidence(record))
    assert.ok(Object.values(result.adoptionChecks).every(Boolean))
    for (const field of ['daemonStartupTiming', 'daemonPreparationTiming']) {
      record[field].phases = Array.from({ length: 64 }, () => ({
        name: 'daemon.adapter.workspace.shadow_clone', startMs: 0, endMs: 1, ms: 1, outcome: 'ok', ignored: privateValue.repeat(1000),
      }))
    }
    const bounded = bootstrapAdoptionDiagnostics(record)
    assert.equal(bounded.startupTiming.phases.length, 64)
    assert.equal(bounded.preparationTiming.phases.length, 64)
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 32768)
    assert.ok(!JSON.stringify(bounded).includes(privateValue))
  }
})

test('bootstrap failure binding checks name the rejected predicate without exporting bootstrap or hint values', async () => {
  const secret = 'private_hint_or_credential_must_not_escape'
  for (const [mutate, expected] of [
    [sample => { sample.bootstrapPublication.runId = DEVICE }, 'publicationRun'],
    [sample => { sample.bootstrapPublication.harness = 'private-harness' }, 'publicationHarness'],
    [sample => { sample.bootstrapPublication.bootstrapSha256 = secret }, 'publicationBootstrapDigest'],
    [sample => { sample.bootstrapPublication.hintSha256 = secret }, 'publicationHintDigest'],
    [sample => { sample.bootstrapPublication.token = secret }, 'publicationShape'],
  ]) {
    const diagnostics = []
    const fixture = candidateFixture(async options => {
      const value = accepted(options.harness)
      mutate(value.samples[0])
      return value
    })
    await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
      /template_gate_subscription_or_cleanup_failed/)
    assert.equal(diagnostics.length, 2)
    for (const row of diagnostics) {
      assert.equal(row.code, 'template_gate_bootstrap_adoption_missing')
      assert.equal(row.bootstrapDiagnostics.bindingChecks[expected], false)
      assert.ok(Object.values(row.bootstrapDiagnostics.adoptionChecks).every(Boolean))
      const encoded = JSON.stringify(row.bootstrapDiagnostics)
      for (const forbidden of [secret, 'private-harness', DEVICE, RUN, 'bootstrapSha256', 'hintSha256']) assert.ok(!encoded.includes(forbidden))
    }
    assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
    assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
    assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
  }
})

test('successful candidate gate adds no failure diagnostics and keeps the original accepted receipt', async () => {
  const diagnostics = [], fixture = candidateFixture(async options => {
    const value = accepted(options.harness)
    value.samples[0].dispatchRefusal = { code: 'deviceNotFound', detail: 'PRIVATE_UNRELATED_DETAIL' }
    return value
  })
  const result = await validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) })
  assert.equal(diagnostics.length, 2)
  assert.deepEqual(fixture.observations, { publications: 2, proofReads: 2 })
  for (const row of diagnostics) {
    assert.equal(row.code, 'passed')
    assert.ok(!Object.hasOwn(row, 'dispatchRefusal'))
    assert.ok(!Object.hasOwn(row, 'bootstrapDiagnostics'))
    const harness = row.kind === 'claude' ? 'claude_code' : 'codex'
    assert.deepEqual(result.subscriptionAcceptance[row.kind], candidateReceipt(report, row.kind,
      { ...proof, bootstrapReceipt: bootstrapReceipt(harness) }, accepted(harness)))
  }
})

test('failure projection distinguishes the closed 3c production shapes using synthetic identities', async () => {
  // Timings/shape only: root-owned 1557 projection SHA a1a8c078a8bcf1d438ec2625b1586576e219b74f1ca0c7478bad0d15bb7cd649.
  // This constructed fixture is not a new production sample: identity, statuses and successful tool evidence use this file's fakes.
  const diagnostics = [], fixture = candidateFixture(async options => {
    const value = accepted(options.harness), sample = value.samples[0]
    const base = { version: 1, runIdHash: hash(RUN).slice(0, 16), harness: options.harness, outcome: 'ok', truncated: false }
    if (options.harness === 'claude_code') {
      sample.daemonStartupTiming = { ...base, startedAt: 1794152294827, endedAt: 1794152294998, ms: 170.639, phases: [] }
      sample.daemonPreparationTiming = { ...base, startedAt: 1794152290901, endedAt: 1794152294997, ms: 4095.802,
        source: 'bootstrap_claude_start', claimAuthentication: 'ordinary_path', observedAuthSource: 'oauth_descriptor',
        phases: [
          { name: 'daemon.adapter.cli_init.prewarm', startMs: 28.874, endMs: 1144.728, ms: 1115.854, outcome: 'ok' },
          { name: 'daemon.adapter.cli_init.prewarm', startMs: 3091.484, endMs: 3909.583, ms: 818.099, outcome: 'ok' },
          { name: 'daemon.adapter.cli_init', startMs: 4093.413, endMs: 4094.363, ms: 0.95, outcome: 'ok' },
          { name: 'daemon.adapter.account_check.account_info', startMs: 4094.391, endMs: 4094.881, ms: 0.49, outcome: 'ok' },
          { name: 'daemon.adapter.account_check', startMs: 4094.898, endMs: 4095.297, ms: 0.399, outcome: 'ok' },
        ] }
    } else {
      sample.daemonStartupTiming = { ...base, startedAt: 1794152357965, endedAt: 1794152359362, ms: 1397.424, phases: [] }
      delete sample.daemonPreparationTiming
      sample.preparationTimingStatus = 'unavailable'
    }
    return value
  })
  await assert.rejects(validateTemplateSubscriptions(report, { ...fixture.options, onDiagnostic: row => diagnostics.push(row) }),
    /template_gate_subscription_or_cleanup_failed/)
  assert.equal(diagnostics.length, 2)
  for (const row of diagnostics) {
    assert.equal(row.code, 'template_gate_bootstrap_adoption_missing')
    assert.equal(row.observation.cliInit, null)
    assert.equal(row.observation.expectedAgentAck, true)
    assert.equal(row.observation.replyVerifiedAfterTool, true)
    const detail = row.bootstrapDiagnostics
    assert.deepEqual(detail.startupTiming.phases, [])
    assert.ok(Object.values(detail.bindingChecks).every(Boolean))
    if (row.kind === 'claude') {
      assert.equal(detail.startupTiming.ms, 170.639)
      assert.equal(detail.preparationTiming.ms, 4095.802)
      assert.deepEqual(detail.preparationTiming.phases.map(phase => phase.ms), [1115.854, 818.099, 0.95, 0.49, 0.399])
      assert.equal(detail.adoptionChecks.prewarmPhaseCount, false)
      assert.equal(detail.adoptionChecks.claimAuthentication, false)
      assert.equal(detail.adoptionChecks.observedAuthSource, false)
      assert.equal(detail.adoptionChecks.cliInitPhaseCount, true)
    } else {
      assert.equal(detail.startupTiming.ms, 1397.424)
      assert.equal(detail.preparationTiming, null)
      assert.equal(detail.preparationTimingStatus, 'unavailable')
      assert.equal(detail.adoptionChecks.preparationReceipt, false)
      assert.equal(detail.adoptionChecks.preparationTimingStatus, false)
    }
  }
  assert.equal(fixture.events.filter(event => event === 'removed').length, 2)
  assert.equal(fixture.events.filter(event => event.startsWith('killed-')).length, 2)
  assert.deepEqual(fixture.events.slice(-2), ['restored-workspace', 'signed-out'])
})
