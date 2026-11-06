import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateReceipt, validateTemplateSubscriptions, validateSubscriptionFiles } from './validate-template-subscriptions.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COMMIT = 'a'.repeat(40), WORKER = 'b'.repeat(40)
const DEVICE = '10000000-0000-4000-8000-000000000001', RUN = '10000000-0000-4000-8000-000000000002'
const report = { sourceCommit: COMMIT, workerSha: WORKER, templates: Object.fromEntries(['claude', 'codex'].map(kind => [kind, {
  templateId: `candidate-${kind}`, baseTemplate: kind, preinstalled: true,
}])) }
const proof = { deviceId: DEVICE, binarySha256: 'c'.repeat(64), version: '0.163.0' }
const accepted = harness => ({ mode: 'candidate', status: 'candidate_subscription_proved', cleanup: { errors: [] }, samples: [{
  status: 'execution_proved_awaiting_server_timing', sourceCommit: COMMIT, harness, runId: RUN,
  execution: { harness, model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', deviceId: DEVICE, credentialType: 'subscription' },
  credentialRoute: 'subscription', replyVerified: true, cleanup: { status: 'passed' },
  minToolCalls: 1, requireReplyAfterTool: true, replyVerifiedAfterTool: true, toolCalls: [{ toolCallHash: 'd'.repeat(16), outcome: 'ok' }],
  requireAgentAcceptance: true, runtimeTiming: { version: 1, source: 'http_server_link', window: 'run_launch_to_agent_exit',
    runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16), harness, complete: true, truncated: false,
    startedAt: 1000, endedAt: 2000, ms: 1000, executionStartMs: 100, executionEndMs: 900,
    requests: [], counts: [], providerOutputChunks: 1, toolCallsStarted: 1, toolCallsCompleted: 1, toolCallsFailed: 0,
    agentAccepted: { kind: harness === 'codex' ? 'codex_turn_start_ack' : 'claude_user_ack', at: 1100, ms: 100 } },
}] })

test('a different application commit is refused before login, enrollment or candidate creation', async () => {
  const calls = []
  await assert.rejects(validateTemplateSubscriptions(report, {
    env: { GITHUB_SHA: COMMIT, ACME_DEMO_EMAIL: 'alex@acme.aspectlylabs.com', ACME_DEMO_PASSWORD: 'fixture',
      MIKKA_ACCEPTANCE_WORKSPACE_ID: DEVICE, MIKKA_ACCEPTANCE_BOT_ID: RUN },
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
    agentAcceptance: { runIdHash: createHash('sha256').update(RUN).digest('hex').slice(0, 16), harness: 'codex', kind: 'codex_turn_start_ack', at: 1100, ms: 100 },
    runtimeAuthorization: { source: 'http_server_link', complete: true, truncated: false, extraRemoteCalls: 0 } })
  for (const mutate of [
    sample => { sample.replyVerified = false }, sample => { sample.execution.credentialType = 'api_key' },
    sample => { sample.execution.deviceId = RUN }, sample => { sample.execution.model = 'other' },
    sample => { sample.sourceCommit = 'd'.repeat(40) }, sample => { sample.cleanup.status = 'failed' },
    sample => { sample.runtimeTiming.agentAccepted.kind = 'claude_system_init' },
    sample => { sample.runtimeTiming.runIdHash = 'f'.repeat(16) },
    sample => { delete sample.runtimeTiming.agentAccepted },
    sample => { sample.runtimeTiming.truncated = true },
    sample => { sample.minToolCalls = 0 }, sample => { sample.toolCalls = [] },
    sample => { sample.toolCalls[0].outcome = 'error' }, sample => { sample.toolCalls[0].toolCallHash = 'raw-tool-id' },
    sample => { sample.replyVerifiedAfterTool = false }, sample => { sample.requireReplyAfterTool = false },
  ]) {
    const value = accepted('codex'); mutate(value.samples[0])
    assert.throws(() => candidateReceipt(report, 'codex', proof, value), /template_gate_/)
  }
})

function candidateFixture(runAcceptance, cleanupFailure) {
  const events = [], devices = []
  const fetchImpl = async (input, init) => {
    const path = new URL(input).pathname
    if (path.endsWith('/api/version')) return Response.json({ build: COMMIT })
    if (path.endsWith('/api/auth/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'session=fixture; HttpOnly' } })
    if (path.endsWith('/api/auth/get-session')) return Response.json({ user: { email: 'alex@acme.aspectlylabs.com' } })
    if (path.endsWith('/api/auth/sign-out')) { events.push('signed-out'); return Response.json({}) }
    assert.ok(init.headers.cookie.includes('session=fixture'))
    if (path.endsWith('/api/devices/enrollment')) return Response.json({ token: 'fixture-one-use' })
    const { action, args } = JSON.parse(init.body)
    if (action === 'workspace.switchWorkspace') return Response.json({ ok: true, result: null })
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
    env: { GITHUB_SHA: COMMIT, ACME_DEMO_EMAIL: 'alex@acme.aspectlylabs.com', ACME_DEMO_PASSWORD: 'fixture',
      MIKKA_ACCEPTANCE_WORKSPACE_ID: DEVICE, MIKKA_ACCEPTANCE_BOT_ID: RUN },
    runAcceptance: async options => {
      assert.equal(options.minToolCalls, 1)
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
  assert.deepEqual(fixture.events, ['created-claude_code', 'tested-claude_code', 'removed', 'killed-claude_code',
    'created-codex', 'tested-codex', 'removed', 'killed-codex', 'signed-out'])
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
