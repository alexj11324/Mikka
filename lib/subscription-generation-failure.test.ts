import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('the real AI SDK stream retains the fixed worker refusal without exposing upstream text', async () => {
  const { use, access } = subscriptionFixture('claude_cpa')
  access.connection!.quota.observedAt = new Date().toISOString()
  const binding = { ...access.binding!, modelId: 'fixture-model' }
  const connection = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const repository = { binding: async () => binding, connection: async () => connection, scope: () => ({}) } as unknown as SubscriptionService['repository']
  for (const [source, expected] of [[new WorkerRefusal('subscription_rate_limited'), 'subscription_rate_limited'], [new Error('fixture-private-provider-text'), 'subscription_generation_failed']] as const) {
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
  }
})
