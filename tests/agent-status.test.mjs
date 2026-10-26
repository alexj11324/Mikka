import assert from 'node:assert/strict'
import test from 'node:test'
import { agentStatusStream, observeAgentStatus } from '../lib/agent-status.ts'

async function collect(stream) {
  const out = []
  for await (const part of stream) out.push(part)
  return out
}

test('状态 chunk 立即发出，工具开始时推送阶段，正文后不再推送，并记录耗时', async () => {
  const logs = []
  const input = ReadableStream.from([
    { type: 'start' }, { type: 'start-step' },
    { type: 'tool-input-start', toolCallId: 'a', toolName: 'web_search' },
    { type: 'finish-step' }, { type: 'start-step' },
    { type: 'tool-input-start', toolCallId: 'b', toolName: 'read_webpage' },
    { type: 'finish-step' }, { type: 'start-step' },
    { type: 'text-delta', id: 't', delta: '你好' },
    { type: 'tool-input-start', toolCallId: 'c', toolName: 'web_search' },
    { type: 'finish-step' }, { type: 'finish', finishReason: 'stop' },
  ])
  const parts = await collect(input.pipeThrough(agentStatusStream({ startedAt: performance.now(), turnId: 'turn', log: entry => logs.push(entry) })))
  const statuses = parts.filter(part => part.type === 'data-agent-status')
  assert.deepEqual(parts[0], { type: 'data-agent-status', data: { phase: 'thinking', step: 0 }, transient: true })
  assert.deepEqual(statuses.map(part => part.data.phase), ['thinking', 'searching', 'reading'])
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'agent.stream.timing')
  assert.equal(logs[0].steps.length, 3)
  assert.deepEqual(logs[0].steps[0].tools, ['web_search'])
  assert.doesNotMatch(JSON.stringify(logs), /你好/)
})

test('客户端观察到状态后在首个正文 chunk 清空', async () => {
  const seen = []
  const encoder = new TextEncoder()
  const lines = [
    { type: 'data-agent-status', data: { phase: 'thinking', step: 0 }, transient: true },
    { type: 'data-agent-status', data: { phase: 'searching', tool: 'web_search', step: 1 }, transient: true },
    { type: 'text-delta', id: 't', delta: 'x' },
  ].map(part => encoder.encode(`data: ${JSON.stringify(part)}\n\n`))
  await collect(ReadableStream.from(lines).pipeThrough(observeAgentStatus(status => seen.push(status?.phase ?? null))))
  assert.deepEqual(seen, ['thinking', 'searching', null])
})
