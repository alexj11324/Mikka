import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { anonymousStartupHint, firstAnonymousTask } from './anonymous-startup-hint'
import { cloudStartupDiagnosticCandidate, cloudStartupDiagnosticEnv } from './startup-diagnostics'

for (const harness of ['claude_code', 'codex'] as const) test(harness + ' emits anonymous hints only for a newly created, never-started first repository task', () => {
  const machine = { created: true, refresh: false, retained: false, question: false }
  const run = { status: 'queued', attempt: 1 }
  assert.equal(firstAnonymousTask(machine, run), true)
  for (const changed of [{ created: false }, { refresh: true }, { retained: true }, { question: true }])
    assert.equal(firstAnonymousTask({ ...machine, ...changed }, run), false)
  for (const changed of [{ status: 'running' }, { attempt: 2 }, { startedAt: new Date() }, { sessionId: 'old' },
    { deviceTokenId: randomUUID() }, { retryOf: randomUUID() }, { continuesRunId: randomUUID() },
    { questionContinuation: {} }, { stopRequestedAt: new Date() }])
    assert.equal(firstAnonymousTask(machine, { ...run, ...changed }), false)
  const bootstrap = JSON.stringify({ deviceId: randomUUID(), credential: 'fixture-bootstrap-credential' })
  const definition = { harness, modelSource: 'subscription', cliModelSelection: 'explicit',
    subscription: { bindingId: randomUUID() }, model: harness + '-any-explicit-model', modelDispatch: { routing: { effort: 'high' } } }
  const input = { runId: randomUUID(), bootstrap, kind: 'implement', repository: 'v2/github.com/owner/project',
    userId: 'owner', botId: randomUUID(), freshTask: true,
    definition: definition as Parameters<typeof anonymousStartupHint>[0]['definition'] }
  const raw = anonymousStartupHint(input)
  const hint = JSON.parse(raw)
  assert.equal(hint.profile, harness === 'claude_code' ? 'cloud_repository_claude_v1' : 'cloud_repository_codex_0166_v1')
  const effort = (name: string) => anonymousStartupHint({ ...input, definition: { ...definition,
    modelDispatch: { routing: { effort: name } } } as typeof input.definition })
  assert.equal(Boolean(effort('max')), harness === 'claude_code')
  assert.equal(Boolean(effort('xhigh')), harness === 'codex')
  assert.equal(hint.runId, input.runId)
  assert.equal(hint.bootstrapSha256, createHash('sha256').update(bootstrap).digest('hex'))
  assert.equal(hint.model, definition.model); assert.equal(hint.effort, 'high')
  assert.equal(hint.diagnostics, false); assert.equal(hint.decisionCatalogue.tool.name, 'record_decision')
  assert.ok(!raw.includes('fixture-bootstrap-credential'))
  assert.equal(anonymousStartupHint({ ...input, freshTask: false }), '')
  for (const changed of [{ harness: 'other' }, { modelSource: 'provider' }, { customMcp: {} }, { cliModelSelection: 'default' }])
    assert.equal(anonymousStartupHint({ ...input, definition: { ...definition, ...changed } as typeof input.definition }), '')
})

test('the early diagnostic candidate and final response use the same exact expiring scope', () => {
  const userId = 'fixture-owner', workspaceId = randomUUID(), botId = randomUUID(), bindingId = randomUUID(), now = Date.now()
  const window = { version: 1, requesterId: userId, workspaceId, botId, repository: 'owner/project', expiresAt: new Date(now + 60000).toISOString() }
  const env = { MIKKA_CLOUD_DIAGNOSTIC_WINDOW: JSON.stringify(window) }
  const scope = { deviceKind: 'cloud', repository: 'owner/project', harness: 'claude_code', subscriptionBindingId: bindingId,
    run: { userId, botId, agentDefinition: { readOnly: true, subscription: { bindingId }, executionIdentity: { requester: userId, workspaceId, botId } } } }
  assert.equal(cloudStartupDiagnosticCandidate(scope, env, now), true)
  assert.deepEqual(cloudStartupDiagnosticEnv({}, scope, env, now), { CLOUD_STARTUP_TIMING: '1' })
  for (const value of [{ ...scope, repository: 'owner/other' }, { ...scope, deviceKind: 'personal' },
    { ...scope, subscriptionBindingId: randomUUID() }, { ...scope, run: { ...scope.run, botId: randomUUID() } }]) {
    assert.equal(cloudStartupDiagnosticCandidate(value, env, now), false)
    assert.deepEqual(cloudStartupDiagnosticEnv({}, value, env, now), {})
  }
  assert.equal(cloudStartupDiagnosticCandidate(scope, env, now + 60001), false)
  assert.deepEqual(cloudStartupDiagnosticEnv({}, scope, env, now + 60001), {})
})
