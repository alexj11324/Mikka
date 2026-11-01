import test from 'node:test'
import assert from 'node:assert/strict'
import { runIsActive, runListRefreshInterval, runStopTimeoutRemaining, runSummaryText, threadItems } from './issue-run-conversation'

test('only active run states offer messages; completed history stays readable', () => {
  for (const state of ['queued', 'preparing', 'running', 'waiting_input', 'finishing']) assert.equal(runIsActive(state), true)
  for (const state of ['succeeded', 'stopped', 'failed', 'cancelled', 'unknown']) assert.equal(runIsActive(state), false)
})
test('a run row shows the report summary, else the first error line, else nothing', () => {
  assert.equal(runSummaryText({ report: { summary: ' Fixed the login loop. ' }, error: null }), 'Fixed the login loop.')
  assert.equal(runSummaryText({ report: { summary: '' }, error: '\nDevice offline\nretrying' }), 'Device offline')
  assert.equal(runSummaryText({ report: 'raw', error: null }), null)
  assert.equal(runSummaryText({ report: null, error: null }), null)
})

test('idle and historical lists do not poll; active runs keep supported refresh', () => {
  assert.equal(runListRefreshInterval(undefined), 0)
  assert.equal(runListRefreshInterval([]), 0)
  assert.equal(runListRefreshInterval([{ status: 'succeeded' }]), 0)
  assert.equal(runListRefreshInterval([{ status: 'succeeded' }, { status: 'running' }]), 5000)
})

test('stop acknowledgement has a bounded deadline through polling, reload and retry', () => {
  const requestedAt = Date.parse('2026-10-27T12:00:00Z')
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt), 30_000)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 25_000), 5_000)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 30_000), 0)
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt + 60_000), 0)
  assert.equal(runStopTimeoutRemaining(requestedAt + 60_000, requestedAt + 60_000), 30_000, 'retry starts its own wait without changing the durable request')
  assert.equal(runStopTimeoutRemaining(requestedAt, requestedAt - 60_000), 30_000, 'clock skew must not create an unbounded wait')
})

test('a thread reads as one conversation: agent text, folded steps and people in time order', () => {
  const t = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, seconds))
  const items = threadItems([
    { chunk: { type: 'text-delta', id: 'a', delta: 'Reproduced ' }, at: t(1) },
    { chunk: { type: 'text-delta', id: 'a', delta: 'it.' }, at: t(2) },
    { chunk: { type: 'tool-input-available', toolCallId: '1' }, at: t(3) },
    { chunk: { type: 'tool-output-available', toolCallId: '1', output: 'x' }, at: t(4) },
    { chunk: { type: 'tool-input-available', toolCallId: '2' }, at: t(5) },
    { chunk: { type: 'text-delta', id: 'b', delta: 'Fixed.' }, at: t(20) },
    { chunk: { type: 'text-delta', id: 'c', delta: '  ' }, at: t(21) },
    { chunk: { type: 'error', errorText: 'Interrupted' }, at: t(30) },
  ], [{ id: 'm', text: 'Check the fallback', author: 'Lin', mine: false, at: t(10) }])
  assert.deepEqual(items.map(item => item.kind === 'steps' ? `steps:${item.count}` : item.kind === 'person' ? `person:${item.author}` : item.kind === 'computer' ? `computer:${item.botId}` : `${item.kind}:${item.text}`),
    ['agent:Reproduced it.', 'steps:2', 'person:Lin', 'agent:Fixed.', 'error:Interrupted'])
})

test('a folded steps line keeps each tool call so it can open: name, what it ran, whether it failed', () => {
  const at = new Date()
  const items = threadItems([
    { chunk: { type: 'tool-input-available', toolCallId: '1', toolName: 'Bash', input: { command: 'pnpm   test\n --watch=false', description: 'Run tests' } }, at },
    { chunk: { type: 'tool-output-error', toolCallId: '1', errorText: 'exit 1' }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '2', toolName: 'apply_patch', input: { files: ['a.ts', 'b.ts'] } }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '3', toolName: 'Read', input: { file_path: `/${'x'.repeat(300)}` } }, at },
    { chunk: { type: 'tool-input-available', toolCallId: '4', input: 'raw' }, at },
  ], [])
  assert.equal(items.length, 1)
  const [steps] = items
  assert.ok(steps.kind === 'steps')
  assert.equal(steps.count, 4)
  assert.deepEqual(steps.steps.slice(0, 2), [
    { id: '1', name: 'Bash', detail: 'pnpm test --watch=false', failed: true },
    { id: '2', name: 'apply_patch', detail: 'a.ts, b.ts', failed: false },
  ])
  assert.equal(steps.steps[2].detail?.length, 200)
  assert.ok(steps.steps[2].detail?.endsWith('…'))
  assert.deepEqual(steps.steps[3], { id: '4', name: 'tool', detail: null, failed: false })
})

test('a thread shows one computer card only for its own run', () => {
  const at = new Date()
  const card = { type: 'data-computer', data: { botId: 'bot-a', runId: 'run-a', task: 'Open the page', state: 'working' } }
  const chunks = [{ chunk: card, at }, { chunk: card, at }, { chunk: { ...card, data: { ...card.data, runId: 'run-b' } }, at }]
  assert.deepEqual(threadItems(chunks, [], 'run-a').map(item => item.kind), ['computer'])
  assert.deepEqual(threadItems(chunks, [], 'run-c'), [])
})
