import test from 'node:test'
import assert from 'node:assert/strict'
import { chainChunks, runFailureText, runIsActive, runListRefreshInterval, runStopTimeoutRemaining, runSummaryText, threadItems } from './issue-run-conversation'

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
  assert.deepEqual(items.map(item => item.kind === 'steps' ? `steps:${item.count}` : item.kind === 'person' ? `person:${item.author}` : item.kind === 'computer' ? `computer:${item.botId}` : item.kind === 'stages' ? `stages:${item.stages.length}` : `${item.kind}:${item.text}`),
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

test('start-up stages fold into one line in order, keep failures, and ignore malformed stage data', () => {
  const at = '2026-11-01T12:00:00Z'
  const items = threadItems([
    { chunk: { type: 'data-run-stage', data: { stage: 'repository', ms: 3200, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'worktree', ms: 400, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'agent_start', ms: 65_700, ok: false } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'docker', ms: 1, ok: true } }, at },
    { chunk: { type: 'data-run-stage', data: { stage: 'worktree', ms: '1', ok: true } }, at },
  ], [])
  assert.deepEqual(items, [{ kind: 'stages', id: 'stages:0', at: Date.parse(at), stages: [
    { stage: 'repository', ms: 3200, ok: true },
    { stage: 'worktree', ms: 400, ok: true },
    { stage: 'agent_start', ms: 65_700, ok: false },
  ] }])
})

test('a failed run says why; any other run says nothing', () => {
  assert.equal(runFailureText('failed', '  docker timed out after 65s\n'), 'docker timed out after 65s')
  assert.equal(runFailureText('failed', null), null)
  assert.equal(runFailureText('failed', '   '), null)
  assert.equal(runFailureText('succeeded', 'leftover error'), null)
  assert.equal(runFailureText('running', 'transient error'), null)
})

test('a thread that ran again reads as one conversation: each run keeps its own text and steps', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, s))
  const rows = [
    { runId: 'r1', chunk: { type: 'text-delta', id: 't1', delta: 'First.' }, at: at(1) },
    { runId: 'r1', chunk: { type: 'tool-input-available', toolCallId: 'a', toolName: 'Edit' }, at: at(2) },
    { runId: 'r2', chunk: { type: 'text-delta', id: 't1', delta: 'Second.' }, at: at(10) },
    { runId: 'r2', chunk: { type: 'tool-input-available', toolCallId: 'a', toolName: 'Bash' }, at: at(11) },
    { runId: 'r2', chunk: { type: 'tool-output-error', toolCallId: 'a', errorText: 'x' }, at: at(12) },
  ]
  const items = threadItems(chainChunks(rows), [{ id: 'm', text: 'Go on.', author: 'Alex', mine: true, at: at(9) }])
  assert.deepEqual(items.map(item => item.kind === 'agent' ? `agent:${item.text}` : item.kind === 'steps' ? `steps:${item.steps.map(step => `${step.name}${step.failed ? '!' : ''}`).join(',')}` : item.kind),
    ['agent:First.', 'steps:Edit', 'person', 'agent:Second.', 'steps:Bash!'])
  assert.deepEqual(chainChunks(rows.slice(0, 2)).map(row => row.chunk.id ?? row.chunk.toolCallId), ['t1', 'a'], 'one run keeps its ids')
})
