import assert from 'node:assert/strict'
import test from 'node:test'
import { isStepCount, streamText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { findRepository } from '../coordinator/repository-resolution'
import { instrumentTools } from './instrument'

test('321 repository descriptions survive instrumented discovery into the next actual SDK model call', async t => {
  const repositories = Array.from({ length: 321 }, (_, index) => ({
    fullName: index === 320 ? 'acme/z-tail-required' : `acme/repository-${String(index).padStart(3, '0')}`,
    description: `说明${String(index).padStart(3, '0')}`.padEnd(300, '界'),
    homepage: `https://example.test/repository/${index}/`.padEnd(300, 'x'),
  }))
  const originalFetch = globalThis.fetch
  let network = 0, listings = 0, calls = 0, requestBytes = 0
  let forwarded: { total: number; repositories: typeof repositories } | undefined
  const audits: string[] = []
  globalThis.fetch = async () => { network++; throw new Error('External transport forbidden in repository output regression') }
  try {
    const tools = instrumentTools({
      find_repository: tool({
        inputSchema: z.object({}),
        execute: async () => findRepository('synthetic-owner', undefined, async ownerId => {
          assert.equal(ownerId, 'synthetic-owner')
          listings++
          return { repositories }
        }),
      }),
    }, ['find_repository'], {
      before: async (_callId, name) => { audits.push(`before:${name}`) },
      after: async (_callId, name, outcome) => { audits.push(`after:${name}:${outcome}`) },
    })
    const model = new MockLanguageModelV4({
      doStream: async options => {
        calls++
        assert.ok(calls <= 2, 'only the tool request and its subsequent model call may run')
        if (calls === 2) {
          const part = options.prompt.flatMap(message => message.role === 'tool' ? message.content : [])
            .find(item => item.type === 'tool-result' && item.toolName === 'find_repository')
          assert.ok(part && part.type === 'tool-result', 'the actual SDK must send the discovery result to its next model call')
          assert.equal(part.output.type, 'json')
          if (part.output.type !== 'json') throw new Error('Expected JSON repository discovery output')
          forwarded = JSON.parse(JSON.stringify(part.output.value)) as { total: number; repositories: typeof repositories }
          requestBytes = Buffer.byteLength(JSON.stringify(options))
        }
        const first = calls === 1
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          if (first) {
            controller.enqueue({ type: 'tool-call', toolCallId: 'discovery-1', toolName: 'find_repository', input: '{}' })
          } else {
            controller.enqueue({ type: 'text-start', id: 'reply' })
            controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'Complete.' })
            controller.enqueue({ type: 'text-end', id: 'reply' })
          }
          controller.enqueue({ type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: first ? 'tool_calls' : 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
          controller.close()
        } }) }
      },
    })
    const result = streamText({ model, tools, prompt: 'Offline regression: discover all repositories.', stopWhen: isStepCount(2), maxRetries: 0 })
    assert.equal(await result.text, 'Complete.')
    assert.ok(forwarded, 'the next model call receives a serialized tool result')
    assert.equal(forwarded.total, 321)
    assert.equal(forwarded.repositories.length, 321, 'no first-50 or byte-based silent truncation')
    for (const expected of repositories) {
      const actual: (typeof repositories)[number] | undefined = forwarded.repositories.find(repository => repository.fullName === expected.fullName)
      assert.ok(actual, `repository omitted: ${expected.fullName}`)
      assert.equal(actual.description, expected.description)
      assert.equal(actual.homepage, expected.homepage)
    }
    assert.equal(forwarded.repositories.at(-1)?.fullName, 'acme/z-tail-required')
    assert.ok(requestBytes > 300_000, 'exercise a substantial UTF-8 tool result rather than tiny names')
    assert.ok(requestBytes < (1 << 20), 'this complete synthetic request fits the existing 1 MiB whole-request limit')
    assert.equal(calls, 2)
    assert.equal(listings, 1)
    assert.equal(network, 0)
    assert.deepEqual(audits, ['before:find_repository', 'after:find_repository:ok'])
    assert.ok(requestBytes > 0)
    t.diagnostic(JSON.stringify({ nextModelRequestBytes: requestBytes, repositoryCount: forwarded.repositories.length, modelCalls: calls, listingCalls: listings, networkCalls: network }))
  } finally { globalThis.fetch = originalFetch }
})
