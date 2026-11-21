import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai'

const admitted: unknown[] = [], selected: unknown[] = []
let nextError: Error | undefined
mock.module(new URL('./abuse/model.ts', import.meta.url).href, { namedExports: {
  admitHostedModel: async (...args: unknown[]) => { admitted.push(args) },
  hostedModel: async (...args: unknown[]) => { selected.push(args); return { modelId: args[1] } },
} })
mock.module('ai', { namedExports: {
  NoObjectGeneratedError, NoOutputGeneratedError, Output,
  generateText: async ({ model, output, abortSignal }: { model: { modelId: string }; output: unknown; abortSignal: AbortSignal }) => {
    abortSignal.throwIfAborted()
    assert.equal(model.modelId, 'mikka-title')
    assert.ok(output, 'the title is requested through structured output')
    const error = nextError
    nextError = undefined
    if (error) throw error
    return { output: { title: 'Fix login' } }
  },
} })

test('short titles admit and use the managed title alias', async () => {
  const { generateShortTitle } = await import('./short-title-server')
  assert.equal(await generateShortTitle('owner', { title: 'Fix login', body: '' }, 'workspace'), 'Fix login')
  assert.deepEqual(admitted, [[{ workspaceId: 'workspace', ownerId: 'owner' }, 'mikka-title', { auditAllowed: false }]])
  assert.deepEqual(selected, [['workspace', 'mikka-title', undefined, 'owner']])
})

test('a title can arrive after a slow converter start', async t => {
  // Evaluate the deadline at the simulated instant the warmed provider replies.
  t.mock.method(AbortSignal, 'timeout', (deadlineMs: number) => deadlineMs <= 35_000
    ? AbortSignal.abort(new DOMException('The title timed out', 'TimeoutError'))
    : new AbortController().signal)
  const { generateShortTitle } = await import('./short-title-server')
  assert.equal(await generateShortTitle('owner', { title: 'Fix login', body: '' }, 'workspace'), 'Fix login')
})


test('schema-invalid model text is still parsed and cut to the title bound', async () => {
  const { generateShortTitle } = await import('./short-title-server')
  nextError = new NoObjectGeneratedError({
    text: JSON.stringify({ title: 'Rebuild the onboarding checklist dialog' }),
    response: { id: 'title-test', timestamp: new Date(0), modelId: 'mikka-title' },
    usage: {
      inputTokens: 0, inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 0, outputTokenDetails: { textTokens: 0, reasoningTokens: 0 }, totalTokens: 0,
    },
    finishReason: 'stop',
  })
  assert.equal(await generateShortTitle('owner', { title: 'Rebuild onboarding', body: '' }, 'workspace'), 'Rebuild the onboarding checklist')
})

test('a model stop without output gives no title', async () => {
  const { generateShortTitle } = await import('./short-title-server')
  nextError = new NoOutputGeneratedError()
  assert.equal(await generateShortTitle('owner', { title: 'Fix login', body: '' }, 'workspace'), null)
})

test('provider errors retain their cause instead of becoming an empty title', async () => {
  const { generateShortTitle } = await import('./short-title-server')
  const error = new Error('provider failed', { cause: new Error('upstream unavailable') })
  nextError = error
  await assert.rejects(generateShortTitle('owner', { title: 'Fix login', body: '' }, 'workspace'), caught => caught === error)
})
