import assert from 'node:assert/strict'
import test from 'node:test'
import { toUIMessageStream } from 'ai'
import { agentSearchStatusStream } from '../lib/agent-search-status.ts'
import { persistAgentStream } from '../lib/agent-history.ts'

async function collect(parts) {
  const input = new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close() } })
  const output = []
  await input.pipeThrough(agentSearchStatusStream()).pipeTo(new WritableStream({ write(part) { output.push(part) } }))
  return output
}

test('Search and scrape degradation emit #63 transient notice contract, not raw provider details', async () => {
  for (const toolName of ['web_search', 'read_webpage']) {
    const parts = [{ type: 'start-step' }, { type: 'tool-input-start', toolCallId: 't', toolName },
      { type: 'tool-output-available', toolCallId: 't', output: { ok: false, notice: 'search_degraded', error: 'sensitive upstream body' } }]
    const result = await collect(parts)
    assert.deepEqual(result[2], { type: 'data-agent-status', transient: true,
      data: { phase: toolName === 'web_search' ? 'searching' : 'reading', tool: toolName, step: 1, notice: 'search_degraded' } })
    assert.doesNotMatch(JSON.stringify(result[2]), /sensitive/)
    assert.deepEqual(result.filter(p => p.type !== 'data-agent-status'), parts)
  }
  assert.equal((await collect([{ type: 'tool-input-start', toolCallId: 't', toolName: 'other' },
    { type: 'tool-output-available', toolCallId: 't', output: { notice: 'search_degraded' } }])).length, 2)
})

test('Degradation notice never becomes persisted assistant text', async () => {
  const parts = await collect([{ type: 'start-step' }, { type: 'tool-input-start', toolCallId: 't', toolName: 'web_search' },
    { type: 'tool-output-available', toolCallId: 't', output: { ok: false, notice: 'search_degraded' } },
    { type: 'text-delta', id: 'x', delta: 'Search unavailable.' }, { type: 'finish', finishReason: 'stop' }])
  const saved = []
  const input = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close() } })
  await persistAgentStream(input, checkpoint => { saved.push(checkpoint) }, new AbortController().signal).pipeTo(new WritableStream())
  assert.equal(saved.at(-1).completion, 'Search unavailable.')
  assert.doesNotMatch(JSON.stringify(saved), /search_degraded/)
})


test('AI SDK complete tool-call events also emit degradation without streamed argument events', async () => {
  const parts = [
    { type: 'start-step' },
    { type: 'tool-call', toolCallId: 'complete-call', toolName: 'web_search', input: { query: 'public query' } },
    { type: 'tool-result', toolCallId: 'complete-call', toolName: 'web_search', input: { query: 'public query' }, output: { ok: false, notice: 'search_degraded' } },
  ]
  const source = new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close() } })
  const observed = []
  await toUIMessageStream({ stream: source }).pipeThrough(agentSearchStatusStream())
    .pipeTo(new WritableStream({ write(part) { observed.push(part) } }))
  assert.equal(observed.some(part => part.type === 'tool-input-start'), false)
  assert.equal(observed.filter(part => part.type === 'data-agent-status').length, 1)
  assert.deepEqual(observed.find(part => part.type === 'data-agent-status').data,
    { phase: 'searching', tool: 'web_search', step: 1, notice: 'search_degraded' })
})
