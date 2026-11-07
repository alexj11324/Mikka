import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { SafeExporter, createTracerProvider } from '../tracing/node'
import { cloudStartupPhases, cloudStartupRunAttributes, cloudStartupSpan, recordCloudBootstrapPhases } from './startup-tracing'
import { cloudStartupDiagnosticEnv } from './startup-diagnostics'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev' })
before(() => provider.register())
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('operator diagnostics only enter the dedicated Bot/repository subscription window', () => {
  const now = Date.parse('2026-11-07T08:00:00Z'), workspaceId = '15050000-0000-4000-8000-000000000010'
  const botId = '15050000-0000-4000-8000-000000000011', requesterId = 'synthetic-requester'
  const window = { version: 1, requesterId, workspaceId, botId, repository: 'owner/repository', expiresAt: '2026-11-07T09:00:00Z' }
  const env = { MIKKA_CLOUD_DIAGNOSTIC_WINDOW: JSON.stringify(window) }
  const scope = { deviceKind: 'cloud', repository: 'owner/repository', harness: 'codex', subscriptionBindingId: 'binding',
    run: { userId: requesterId, botId, agentDefinition: { readOnly: true, subscription: { bindingId: 'binding' },
      executionIdentity: { requester: requesterId, workspaceId, botId } } } }
  const taskEnv = { USER_SETTING: 'preserved' }, original = structuredClone(scope)
  for (const harness of ['codex', 'claude_code']) {
    assert.deepEqual(cloudStartupDiagnosticEnv(taskEnv, { ...scope, harness }, env, now), { ...taskEnv, CLOUD_STARTUP_TIMING: '1' })
  }
  for (const other of [
    { ...scope, deviceKind: 'local' }, { ...scope, repository: 'owner/another' }, { ...scope, repository: null },
    { ...scope, harness: 'cursor' }, { ...scope, subscriptionBindingId: undefined }, { ...scope, subscriptionBindingId: 'another' },
    { ...scope, run: { ...scope.run, userId: 'another' } }, { ...scope, run: { ...scope.run, botId: 'another' } },
    { ...scope, run: { ...scope.run, agentDefinition: null } },
    ...['requester', 'workspaceId', 'botId'].map(key => ({ ...scope, run: { ...scope.run, agentDefinition: { ...scope.run.agentDefinition,
      executionIdentity: { ...scope.run.agentDefinition.executionIdentity, [key]: 'another' } } } })),
    { ...scope, run: { ...scope.run, agentDefinition: { ...scope.run.agentDefinition, readOnly: false } } },
  ]) assert.equal(cloudStartupDiagnosticEnv(taskEnv, other, env, now), taskEnv)
  for (const configuration of [undefined, '', '{invalid', JSON.stringify({ ...window, expiresAt: '2026-11-07T07:00:00Z' }),
    JSON.stringify({ ...window, expiresAt: '2026-12-07T09:00:00Z' }), JSON.stringify({ ...window, botId: '*' }),
    JSON.stringify({ ...window, unexpected: true })]) {
    assert.equal(cloudStartupDiagnosticEnv(taskEnv, scope, { MIKKA_CLOUD_DIAGNOSTIC_WINDOW: configuration }, now), taskEnv)
  }
  assert.deepEqual(scope, original)
  assert.deepEqual(taskEnv, { USER_SETTING: 'preserved' })
  const explicit = { CLOUD_STARTUP_TIMING: '1' }
  assert.equal(cloudStartupDiagnosticEnv(explicit, { ...scope, deviceKind: 'local' }, {}, now), explicit)
})

test('startup phases preserve their parent and expose only a hashed run identity', async () => {
  memory.reset()
  const runId = '15050000-0000-4000-8000-000000000001'
  const attributes = cloudStartupRunAttributes(runId)
  const value = await cloudStartupSpan('cloud.thread.ensure', attributes, async () => {
    const phases = cloudStartupPhases(attributes)
    phases.next('admission')
    await Promise.resolve()
    phases.next('connect')
    await cloudStartupSpan('cloud.sandbox.create', attributes, async () => 7)
    phases.end()
    return 42
  })
  await provider.forceFlush()
  assert.equal(value, 42)
  const spans = memory.getFinishedSpans()
  const parent = spans.find(span => span.name === 'cloud.thread.ensure')!
  assert.equal(spans.length, 4)
  for (const span of spans) {
    assert.equal(span.attributes['mikka.run.id_hash'], attributes['mikka.run.id_hash'])
    if (span !== parent) assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId)
    assert.ok(span.duration[0] >= 0)
  }
  assert.ok(!JSON.stringify(spans.map(span => span.attributes)).includes(runId))
})

test('failed provisioning preserves the original error without publishing its message', async () => {
  memory.reset()
  const failure = new Error('private credential must never reach a trace')
  await assert.rejects(cloudStartupSpan('cloud.sandbox.create', {}, async () => { throw failure }), error => error === failure)
  await provider.forceFlush()
  const [span] = memory.getFinishedSpans()
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.ok(!JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes(failure.message))
})

test('claim phases and parallel credential spans keep the claim parent', async () => {
  memory.reset()
  const attributes = cloudStartupRunAttributes('15050000-0000-4000-8000-000000000002')
  await cloudStartupSpan('cloud.worker.claim', attributes, async () => {
    const phases = cloudStartupPhases(attributes, 'cloud.worker.claim')
    phases.next('authorize')
    await Promise.resolve()
    phases.next('assignment_context')
    await Promise.all([
      cloudStartupSpan('cloud.worker.claim.native_credentials', attributes, async () => undefined),
      cloudStartupSpan('cloud.worker.claim.github_credentials', attributes, async () => undefined),
    ])
    phases.next('response_fence')
    phases.end()
  })
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  const parent = spans.find(span => span.name === 'cloud.worker.claim')!
  assert.equal(spans.length, 6)
  for (const span of spans) {
    assert.equal(span.attributes['mikka.run.id_hash'], attributes['mikka.run.id_hash'])
    if (span !== parent) assert.equal(span.parentSpanContext?.spanId, parent.spanContext().spanId)
  }
  assert.ok(spans.every(span => span.name.startsWith('cloud.worker.claim')))
})

test('remote bootstrap receipts produce exact phase durations without exporting command output', async () => {
  memory.reset()
  const startedAt = Date.now() - 5_000
  await cloudStartupSpan('cloud.sandbox.bootstrap', {}, async () => {
    recordCloudBootstrapPhases('private package-manager output\nmikka-bootstrap-phase source 1200\nmikka-bootstrap-phase secret_token 100\nmikka-bootstrap-phase dependencies 2500\n', startedAt, startedAt + 4_000)
  })
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  const parent = spans.find(span => span.name === 'cloud.sandbox.bootstrap')!
  const stages = spans.filter(span => span !== parent)
  assert.deepEqual(stages.map(span => [span.name, span.duration]), [
    ['cloud.bootstrap.source', [1, 200_000_000]],
    ['cloud.bootstrap.dependencies', [2, 500_000_000]],
  ])
  assert.ok(stages.every(span => span.parentSpanContext?.spanId === parent.spanContext().spanId))
  assert.ok(!JSON.stringify(stages.map(span => ({ name: span.name, attributes: span.attributes }))).includes('private'))
})
