import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { SubscriptionService } from './subscription-service'
import { subscriptionFixture } from '../tests/fixtures/subscription'

function controlledSubscription() {
  const { use, access } = subscriptionFixture('claude_cpa')
  access.connection!.quota.observedAt = new Date().toISOString()
  const binding = { ...access.binding!, modelId: 'fixture-model' }
  const connection = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const repository = { binding: async () => binding, connection: async () => connection, scope: () => ({}) } as unknown as SubscriptionService['repository']
  const stop = new AbortController()
  let body!: ReadableStreamDefaultController<Uint8Array>, workerSignal: AbortSignal | undefined
  let starts = 0, startFailure: unknown
  const worker = {
    forUse() { return this },
    stream: (_revision: number, _model: string, _payload: unknown, signal?: AbortSignal) => {
      starts++; workerSignal = signal
      if (startFailure) { stop.abort(); throw startFailure }
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture-model', choices: [{ index: 0, delta: { content: 'Before stop.' }, finish_reason: null }] }
      return new ReadableStream<Uint8Array>({ start(controller) {
        body = controller
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
      } })
    },
  } as unknown as ReturnType<SubscriptionService['worker']>
  const service = new SubscriptionService(repository, () => worker, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => {}, async () => {})
  return {
    stop, service, use,
    fail(error: unknown) { body.error(error) },
    failAtStart(error: unknown) { startFailure = error },
    get starts() { return starts },
    get workerSignal() { return workerSignal },
  }
}

function hasCause(error: unknown, original: unknown) {
  for (let depth = 0; error instanceof Error && depth < 6; depth++, error = error.cause) if (error === original) return true
  return false
}

test('the real SDK keeps requested worker cancellation as AbortError, with no public error part', async t => {
  const logs: string[] = []
  t.mock.method(console, 'warn', (line: string) => logs.push(line))
  for (const suppliedAt of ['both', 'request', 'construction', 'native AbortError'] as const) {
    await t.test(suppliedAt, async () => {
      const fixture = controlledSubscription()
      const model = await fixture.service.model(fixture.use, suppliedAt === 'request' ? undefined : fixture.stop.signal)
      if (model.specificationVersion !== 'v4') throw new Error('expected current SDK model')
      const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], ...(suppliedAt === 'construction' ? {} : { abortSignal: fixture.stop.signal }) })
      const reader = response.stream.getReader()
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        assert.equal(done, false)
        assert.notEqual(value?.type, 'error')
        if (value?.type === 'text-delta') { text += value.delta; break }
      }
      assert.equal(text, 'Before stop.')
      assert.equal(fixture.workerSignal, fixture.stop.signal)
      const cancelled = suppliedAt === 'native AbortError' ? new DOMException('Synthetic cancellation', 'AbortError') : new WorkerRefusal('subscription_cancelled')
      fixture.stop.abort()
      fixture.fail(cancelled)
      await assert.rejects(async () => {
        for (;;) {
          const next = await reader.read()
          if (next.done) return
          assert.notEqual(next.value.type, 'error', 'a requested cancellation must not become a normal model error part')
        }
      }, error => error instanceof Error && error.name === 'AbortError' && hasCause(error, cancelled))
      reader.releaseLock()
      assert.equal(fixture.starts, 1)
    })
  }
  assert.equal(logs.length, 0, 'requested cancellation is not a subscription generation failure')
})

test('start cancellation retains its cause and does not become a generation failure or retry', async t => {
  const logs: string[] = []
  t.mock.method(console, 'warn', (line: string) => logs.push(line))
  const fixture = controlledSubscription()
  const model = await fixture.service.model(fixture.use, fixture.stop.signal)
  if (model.specificationVersion !== 'v4') throw new Error('expected current SDK model')
  const cancelled = new WorkerRefusal('subscription_cancelled')
  fixture.failAtStart(cancelled)
  await assert.rejects(async () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], abortSignal: fixture.stop.signal }), (error: unknown) => error instanceof Error && error.name === 'AbortError' && hasCause(error, cancelled))
  assert.equal(fixture.starts, 1)
  assert.equal(logs.length, 0)
})

test('no stop, forged codes, provider failures, and deadline expiry retain the normal error path', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const scenario of [
    { name: 'worker cancellation without an aborted signal', error: new WorkerRefusal('subscription_cancelled'), abort: false, expected: 'subscription_generation_failed' },
    { name: 'provider refusal after stop', error: new WorkerRefusal('subscription_rate_limited'), abort: true, expected: 'subscription_rate_limited' },
    { name: 'untrusted cancellation code after stop', error: { code: 'subscription_cancelled' }, abort: true, expected: 'subscription_generation_failed' },
    { name: 'worker cancellation from a deadline', error: new WorkerRefusal('subscription_cancelled'), abort: true, reason: new DOMException('Synthetic deadline', 'TimeoutError'), expected: 'subscription_generation_failed' },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = controlledSubscription()
      const model = await fixture.service.model(fixture.use, fixture.stop.signal)
      if (model.specificationVersion !== 'v4') throw new Error('expected current SDK model')
      const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], abortSignal: fixture.stop.signal })
      const reader = response.stream.getReader()
      for (;;) {
        const next = await reader.read()
        assert.equal(next.done, false)
        if (next.value?.type === 'text-delta') break
      }
      if (scenario.abort) fixture.stop.abort(scenario.reason)
      fixture.fail(scenario.error)
      const errors: unknown[] = []
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        if (next.value.type === 'error') errors.push(next.value.error)
      }
      reader.releaseLock()
      assert.equal(errors.length, 1)
      assert.equal((errors[0] as Error).message, scenario.expected)
      assert.equal(fixture.starts, 1)
    })
  }
})
