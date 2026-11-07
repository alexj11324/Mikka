import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APICallError, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { GatewayInternalServerError } from '@ai-sdk/gateway'
import { captureRunFailure, failureFrom } from '@mikka/protocol/run-failure'
import { WorkflowAbortError, WorkflowProviderFailureError, WorkflowRunFailureError, workflowFailureCall, workflowFailureStream } from './workflow-run-failure'

const require = createRequire(import.meta.url)
const core = dirname(createRequire(require.resolve('workflow')).resolve('@workflow/core'))
const { devalueCodec } = await import(pathToFileURL(join(core, 'serialization/codec-devalue.js')).href)
const { registerSerializationClass } = await import(pathToFileURL(join(core, 'class-serialization.js')).href)
registerSerializationClass('mikka-test-workflow-run-failure', WorkflowRunFailureError)
registerSerializationClass('mikka-test-workflow-provider-failure', WorkflowProviderFailureError)
registerSerializationClass('mikka-test-workflow-abort', WorkflowAbortError)

const providerError = () => Object.assign(new Error('private upstream diagnostic'), {
  statusCode: 400, responseBody: JSON.stringify({ error: { type: 'invalid_request_error', message: 'The requested operation is not supported.' } }),
  requestBodyValues: { messages: [{ role: 'user', content: 'A private synthetic user message.' }] },
})
const context = { runId: 'wrun_failure_fixture', appVersion: 'a'.repeat(40), provider: 'codex', credential: 'subscription' as const }

test('actual Workflow codec retains safe failure details across a cold decode and excludes raw cause', () => {
  const error = providerError()
  const failure = captureRunFailure(error, context)
  const ordinary = devalueCodec.deserialize(devalueCodec.serialize(Object.assign(new Error('fixed'), { failureDetails: failure }), 'step'), 'workflow')
  assert.equal(ordinary.failureDetails, undefined, 'a plain Error is insufficient across this boundary')
  const wrapped = new WorkflowRunFailureError(failure, { cause: error }, 'subscription_generation_failed')
  assert.equal(wrapped.cause, error, 'the Node host keeps the real cause in memory')
  const bytes = devalueCodec.serialize(wrapped, 'step')
  const encoded = new TextDecoder().decode(bytes)
  assert.doesNotMatch(encoded, /private upstream diagnostic|A private synthetic user message|requestBodyValues|responseBody/)
  const decoded = devalueCodec.deserialize(bytes, 'workflow')
  assert.ok(decoded instanceof WorkflowRunFailureError)
  assert.equal(decoded.message, 'subscription_generation_failed', 'legacy refusal routing is retained')
  assert.deepEqual(failureFrom(decoded), failure)
  assert.equal(decoded.cause, undefined, 'raw provider causes do not enter durable diagnostics')
})

test('Node stream start, error chunk and stream rejection all carry the same durable failure', async () => {
  const error = providerError()
  const check = (value: unknown) => {
    assert.ok(value instanceof WorkflowRunFailureError)
    assert.equal(failureFrom(value)?.category, 'invalid_request')
    assert.equal(failureFrom(value)?.runId, context.runId)
    assert.equal(failureFrom(value)?.providerMessage, 'The requested operation is not supported.')
    return true
  }
  await assert.rejects(workflowFailureStream(async () => { throw error }, context), check)
  const chunked = await workflowFailureStream(async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'error', error }); controller.close() } }) }), context)
  const chunk = await chunked.stream.getReader().read()
  assert.equal(chunk.value?.type, 'error')
  if (chunk.value?.type === 'error') check(chunk.value.error)
  const rejected = await workflowFailureStream(async () => ({ stream: new ReadableStream({ start(controller) { controller.error(error) } }) }), context)
  await assert.rejects(rejected.stream.getReader().read(), check)
})

test('successful stream parts and cancellation retain their original transport semantics', async () => {
  const part = { type: 'text-delta' as const, id: 'text', delta: 'reply' }
  const reason = new Error('cancel-fixture')
  let cancelled: unknown
  const source = new ReadableStream({ start(controller) { controller.enqueue(part) }, cancel(value) { cancelled = value } })
  const result = await workflowFailureStream(async () => ({ stream: source }), context)
  const reader = result.stream.getReader()
  assert.deepEqual((await reader.read()).value, part)
  await reader.cancel(reason)
  assert.equal(cancelled, reason)
  const cycle: Record<string, unknown> = { content: 'private prompt content' }; cycle.self = cycle
  assert.equal(captureRunFailure(providerError(), { requestBodyValues: cycle }).providerMessage, 'The requested operation is not supported.')
})

test('start, stream error and rejected read preserve AbortError through actual Workflow serialization', async () => {
  const error = Object.assign(new Error('private cancellation reason'), { name: 'AbortError' })
  const check = (value: unknown) => {
    assert.ok(value instanceof WorkflowAbortError)
    assert.equal(value.name, 'AbortError')
    assert.equal(value.cause, error)
    assert.equal(failureFrom(value), null)
    const bytes = devalueCodec.serialize(value, 'step')
    assert.doesNotMatch(new TextDecoder().decode(bytes), /private cancellation reason/)
    const decoded = devalueCodec.deserialize(bytes, 'workflow')
    assert.equal(decoded.name, 'AbortError'); assert.equal(decoded.cause, undefined)
    return true
  }
  await assert.rejects(workflowFailureCall(async () => { throw error }, context), check)
  const chunked = await workflowFailureStream(async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: 'error', error }); controller.close() } }) }), context)
  const chunk = await chunked.stream.getReader().read()
  assert.equal(chunk.value?.type, 'error'); if (chunk.value?.type === 'error') check(chunk.value.error)
  const rejected = await workflowFailureStream(async () => ({ stream: new ReadableStream({ start(controller) { controller.error(error) } }) }), context)
  await assert.rejects(rejected.stream.getReader().read(), check)
})

test('API and Gateway retry decisions and safe delay values survive cold Workflow decoding', async () => {
  for (const retryable of [true, false]) {
    const upstream = new APICallError({ message: 'private upstream', url: 'https://private.invalid', requestBodyValues: { input: 'private input' },
      statusCode: 503, isRetryable: retryable, responseHeaders: { 'retry-after-ms': '0 private header', 'retry-after': '2', authorization: 'private credential' } })
    for (const error of [upstream, new GatewayInternalServerError({ cause: upstream })]) {
      const wrapped = await workflowFailureCall(async () => { throw error }, context).catch(value => value)
      assert.ok(APICallError.isInstance(wrapped))
      assert.equal(wrapped.isRetryable, error.isRetryable)
      assert.equal(wrapped.cause, error)
      assert.deepEqual(wrapped.responseHeaders, { 'retry-after-ms': '0', 'retry-after': '2' })
      const bytes = devalueCodec.serialize(wrapped, 'step')
      assert.doesNotMatch(new TextDecoder().decode(bytes), /private upstream|private\.invalid|private input|private header|private credential|authorization/)
      const decoded = devalueCodec.deserialize(bytes, 'workflow')
      assert.ok(APICallError.isInstance(decoded))
      assert.equal(decoded.isRetryable, error.isRetryable)
      assert.equal(decoded.statusCode, error.statusCode)
      assert.deepEqual(decoded.responseHeaders, wrapped.responseHeaders)
      assert.equal(decoded.cause, undefined)
    }
  }
})

test('the real AI SDK retains its retry count around the diagnostic wrapper', async () => {
  for (const scenario of [{ retryable: true, maxRetries: 1, calls: 2 }, { retryable: false, maxRetries: 1, calls: 1 }, { retryable: true, maxRetries: 0, calls: 1 }]) {
    let calls = 0
    const upstream = new APICallError({ message: 'private fixture', url: '', requestBodyValues: {}, statusCode: 503,
      isRetryable: scenario.retryable, responseHeaders: { 'retry-after-ms': '0' } })
    const model = new MockLanguageModelV4({ doStream: () => workflowFailureStream(async () => {
      calls++
      if (calls === 1) throw upstream
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'text-start', id: 'reply' })
        controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'ok' })
        controller.enqueue({ type: 'text-end', id: 'reply' })
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
        controller.close()
      } }) }
    }, context) })
    const result = streamText({ model, prompt: 'synthetic fixture', maxRetries: scenario.maxRetries, onError() {} })
    const text = await Promise.resolve(result.text).catch(() => '')
    assert.equal(calls, scenario.calls)
    if (scenario.calls === 2) assert.equal(text, 'ok')
  }
})

test('existing hosted admission notices survive model factory failures and durable decoding', async () => {
  const error = new Error('points_exhausted')
  const failure = await workflowFailureCall(async () => { throw error }, context).catch(value => value)
  assert.equal(failure.message, 'points_exhausted')
  assert.equal(failure.cause, error)
  const decoded = devalueCodec.deserialize(devalueCodec.serialize(failure, 'step'), 'workflow')
  assert.equal(decoded.message, 'points_exhausted')
  assert.ok(failureFrom(decoded))
})
