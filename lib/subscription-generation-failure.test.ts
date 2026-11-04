import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APICallError, InvalidResponseDataError } from 'ai'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { generationFailureCode, subscriptionGenerationError, SubscriptionService } from './subscription-service'
import { subscriptionFixture } from '../tests/fixtures/subscription'

test('a failed subscription turn logs only its fixed code, never the message', () => {
  assert.equal(generationFailureCode(new WorkerRefusal('provider_operation_failed')), 'provider_operation_failed')
  assert.equal(generationFailureCode(new SubscriptionRefusal('quota_unknown')), 'quota_unknown')
  assert.equal(generationFailureCode(new TypeError('fixture provider text: secret')), 'TypeError')
  assert.equal(generationFailureCode({ code: 'Not A Code With spaces' }), 'unknown')
  assert.equal(generationFailureCode('fixture string'), 'unknown')
  assert.equal(generationFailureCode({ code: 'fixture_private_token' }), 'unknown')
  assert.equal(generationFailureCode(new WorkerRefusal('fixture_private_token')), 'WorkerRefusal')
  assert.equal(generationFailureCode(new InvalidResponseDataError({ data: 'fixture-private-data' })), 'AI_InvalidResponseDataError')
  assert.equal(generationFailureCode(new APICallError({ message: 'fixture-private-message', url: 'https://fixture.invalid/private', requestBodyValues: {} })), 'AI_APICallError')
})

test('known subscription failures survive the SDK wrapper as fixed actionable codes', () => {
  for (const code of ['subscription_rate_limited', 'provider_access_denied', 'provider_request_rejected', 'provider_temporarily_unavailable', 'provider_route_unavailable']) {
    const wrapped = new Error('SDK response contains fixture-private-text', { cause: new WorkerRefusal(code) })
    assert.equal(subscriptionGenerationError(wrapped).message, code)
  }
  assert.equal(subscriptionGenerationError(new SubscriptionRefusal('stale_binding')).message, 'stale_binding')
  assert.equal(subscriptionGenerationError(new WorkerRefusal('invalid_credential_bundle')).message, 'reconnect_required')
})

test('unknown failures and provider supplied code fields never reach the chat', () => {
  for (const error of [new Error('fixture-private-text'), { code: 'subscription_rate_limited' }, new WorkerRefusal('fixture_private_token'), new Error('fixture-private-text', { cause: { code: 'reconnect_required' } })]) {
    assert.equal(subscriptionGenerationError(error).message, 'subscription_generation_failed')
  }
})

test('the real AI SDK stream retains the fixed worker refusal without exposing upstream text', async t => {
  const logs: string[] = []
  t.mock.method(console, 'warn', (line: string) => logs.push(line))
  const { use, access } = subscriptionFixture('claude_cpa')
  access.connection!.quota.observedAt = new Date().toISOString()
  const binding = { ...access.binding!, modelId: 'fixture-model' }
  const connection = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const repository = { binding: async () => binding, connection: async () => connection, scope: () => ({}) } as unknown as SubscriptionService['repository']
  const sdkError = new APICallError({ message: 'fixture-private-provider-text', url: 'https://fixture.invalid/private', requestBodyValues: { secret: 'fixture-private-input' }, responseBody: 'fixture-private-body', responseHeaders: { authorization: 'fixture-private-header' }, statusCode: 503, cause: Object.assign(new Error('fixture-private-cause'), { code: 'ECONNRESET' }) })
  for (const [source, expected] of [[new WorkerRefusal('subscription_rate_limited'), 'subscription_rate_limited'], [new Error('fixture-private-provider-text'), 'subscription_generation_failed'], [sdkError, 'subscription_generation_failed']] as const) {
    const logStart = logs.length
    const worker = { forUse() { return this }, stream: () => new ReadableStream({ start(controller) { controller.error(source) } }) } as unknown as ReturnType<SubscriptionService['worker']>
    const service = new SubscriptionService(repository, () => worker, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => {}, async () => {})
    const model = await service.model(use)
    assert.notEqual(model.specificationVersion, 'v2')
    if (model.specificationVersion !== 'v4' && model.specificationVersion !== 'v3') throw new Error('expected current SDK model')
    const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
    const errors: unknown[] = []
    for await (const part of response.stream) if (part.type === 'error') errors.push(part.error)
    assert.equal(errors.length, 1)
    assert.equal((errors[0] as Error).message, expected)
    if (source === sdkError) {
      const diagnostic = logs.slice(logStart).map(line => JSON.parse(line)).find(line => line.stage === 'stream')
      assert.ok(diagnostic, 'the actual SDK error must retain a stream diagnostic')
      assert.equal(diagnostic.code, 'AI_APICallError')
      // The SDK wraps the failed response body with the bridge's HTTP 200;
      // the injected provider status remains on the original error in cause.
      assert.equal(diagnostic.statusCode, 200)
      assert.deepEqual(diagnostic.causes, [
        { errorClass: 'AI_APICallError', errorCode: null, statusCode: 503 },
        { errorClass: 'Error', errorCode: 'ECONNRESET', statusCode: null },
      ])
    }
  }
  assert.ok(!logs.join('\n').includes('fixture-private'))
})

test('the real SDK enforces the existing worker byte limit before inference or admission writes', async t => {
  const logs: string[] = []
  let loggingFails = false
  t.mock.method(console, 'warn', (line: string) => {
    if (loggingFails) throw new Error('fixture-private-log-failure')
    logs.push(line)
  })
  const { use, access } = subscriptionFixture('claude_cpa')
  access.connection!.quota.observedAt = new Date().toISOString()
  const binding = { ...access.binding!, modelId: 'fixture-model' }
  const connection = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  let workerStarts = 0, admissions = 0, writes = 0
  let capturedPayload: unknown
  const repository = {
    binding: async () => binding, connection: async () => connection, scope: () => ({}),
    saveQuota: async () => { writes++; throw new Error('unexpected fixture write') },
  } as unknown as SubscriptionService['repository']
  const worker = {
    forUse() { return this },
    stream: (_revision: number, _model: string, payload: unknown) => {
      workerStarts++; capturedPayload = payload
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture-model', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }
      const finish = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`)); controller.close() } })
    },
  } as unknown as ReturnType<SubscriptionService['worker']>
  const service = new SubscriptionService(repository, () => worker, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => {}, async () => { admissions++ })
  const model = await service.model(use)
  if (model.specificationVersion !== 'v4') throw new Error('expected current SDK model')
  const invoke = async (text: string) => {
    const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text }] }] })
    for await (const part of response.stream) if (part.type === 'error') throw part.error
  }
  // Measure the real SDK envelope once; no fixture copies its serialization.
  await invoke('')
  const baseline = JSON.stringify(capturedPayload)
  assert.equal(typeof baseline, 'string')
  const capacity = 262144 - Buffer.byteLength(baseline, 'utf8')
  const multibyteBoundary = '汉'.repeat(Math.floor(capacity / 3)) + 'x'.repeat(capacity % 3)
  for (const scenario of [
    { name: 'ASCII exact byte boundary', text: 'x'.repeat(capacity), error: null },
    { name: 'UTF-8 exact byte boundary', text: multibyteBoundary, error: null },
    { name: 'existing ASCII refusal', text: 'x'.repeat(capacity + 1), error: 'backend_unavailable' },
    { name: 'UTF-16 fits but UTF-8 exceeds', text: multibyteBoundary + 'x', error: 'subscription_generation_failed' },
    { name: 'logging cannot replace the refusal', text: multibyteBoundary + 'x', error: 'subscription_generation_failed', loggingFails: true },
  ]) {
    await t.test(scenario.name, async () => {
      workerStarts = 0; admissions = 0; logs.length = 0; loggingFails = scenario.loggingFails ?? false
      if (scenario.error) {
        await assert.rejects(invoke(scenario.text), { message: scenario.error })
        assert.equal(workerStarts, 0, 'oversized input must not start the worker stream')
        assert.equal(admissions, 0, 'oversized input must not record another generation admission')
        if (!loggingFails) {
          const boundary = logs.map(line => JSON.parse(line)).find(line => line.msg === 'subscription_request_failure')
          assert.ok(boundary)
          assert.equal(boundary.phase, 'host_input')
          assert.equal(boundary.reason, 'payload_too_large')
          assert.equal(boundary.bytes, 262145)
          assert.equal(boundary.limit, 262144)
          assert.ok(!logs.join('\n').includes('汉'))
        }
      } else {
        await invoke(scenario.text)
        assert.equal(workerStarts, 1)
        assert.equal(admissions, 1)
        assert.equal(Buffer.byteLength(JSON.stringify(capturedPayload), 'utf8'), 262144)
      }
      assert.equal(writes, 0, 'no credential or quota mutation is needed')
    })
  }
})
