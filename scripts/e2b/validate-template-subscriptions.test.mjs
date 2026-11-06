import assert from 'node:assert/strict'
import test from 'node:test'
import { candidateReceipt, validateTemplateSubscriptions } from './validate-template-subscriptions.mjs'

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
    deviceId: DEVICE, officialBinarySha256: proof.binarySha256, officialCliVersion: proof.version })
  for (const mutate of [
    sample => { sample.replyVerified = false }, sample => { sample.execution.credentialType = 'api_key' },
    sample => { sample.execution.deviceId = RUN }, sample => { sample.execution.model = 'other' },
    sample => { sample.sourceCommit = 'd'.repeat(40) }, sample => { sample.cleanup.status = 'failed' },
  ]) {
    const value = accepted('codex'); mutate(value.samples[0])
    assert.throws(() => candidateReceipt(report, 'codex', proof, value), /template_gate_/)
  }
})

test('a failed subscription still tests the other candidate and closes every created instance and device', async () => {
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
    if (action === 'agents.removeDevice') { assert.deepEqual(args, [DEVICE]); events.push('removed'); return Response.json({ ok: true, result: { id: DEVICE } }) }
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
      kill: async () => { events.push(`killed-${harness}`) },
    }
  }
  await assert.rejects(validateTemplateSubscriptions(report, { fetchImpl, sandboxFactory,
    env: { GITHUB_SHA: COMMIT, ACME_DEMO_EMAIL: 'alex@acme.aspectlylabs.com', ACME_DEMO_PASSWORD: 'fixture',
      MIKKA_ACCEPTANCE_WORKSPACE_ID: DEVICE, MIKKA_ACCEPTANCE_BOT_ID: RUN },
    runAcceptance: async options => {
      events.push(`tested-${options.harness}`)
      if (options.harness === 'claude_code') throw Error('fixture provider blocked')
      return accepted(options.harness)
    },
  }), /template_gate_subscription_or_cleanup_failed/)
  assert.deepEqual(events, ['created-claude_code', 'tested-claude_code', 'removed', 'killed-claude_code',
    'created-codex', 'tested-codex', 'removed', 'killed-codex', 'signed-out'])
})
