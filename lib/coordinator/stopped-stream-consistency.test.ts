import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelMessage } from 'ai'
import { fingerprint } from '@/lib/credentials/fingerprint'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import { coordinatorTextStream } from './stream-response'
import { coordinatorStreamReply, type CoordinatorLiveReply } from '../coordinator-stream-client'
import { stoppedStepText, stoppedMessages, lastAssistantText } from './stop'
import { chatItems } from './context'
import type { CoordinatorStreamEvent, CoordinatorWorkflowStreamPart } from './stream'

const id = 'stopped-round:0'
const at = new Date('2026-11-08T04:22:00Z')
const rawStream = (list: readonly CoordinatorWorkflowStreamPart[]) => new ReadableStream<CoordinatorWorkflowStreamPart>({
  start(controller) { for (const part of list) controller.enqueue(part); controller.close() },
})
const modelPart = (scoped: boolean, part: unknown): CoordinatorWorkflowStreamPart =>
  (scoped ? { type: 'coordinator-model-part', id, part } : part) as CoordinatorWorkflowStreamPart

async function stoppedProjection(scoped: boolean, chunks: unknown[], completed: ModelMessage[] = [], held = false, quietEligible = false) {
  const raw: CoordinatorWorkflowStreamPart[] = [
    { type: 'coordinator-turn-start', id, quietEligible, ...(scoped ? { modelStream: 'scoped-v1' as const } : {}) },
    ...chunks.map(part => modelPart(scoped, part)),
    { type: 'coordinator-turn-stopped', id },
    modelPart(scoped, { type: 'text-delta', id: 't', text: 'late text must stay absent' }),
    modelPart(scoped, { type: 'reset-step' }),
    { type: 'coordinator-turn-committed', id, through: 20, quiet: false },
  ]
  const previous = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'offline-stopped-projection-fixture'
  try {
    const fingerprints = held ? [fingerprint('owner', 'a-saved-secret-that-never-occurs-in-this-reply')] : []
    const events: CoordinatorStreamEvent[] = []
    for await (const event of rawStream(raw).pipeThrough(coordinatorTextStream('owner', fingerprints))) events.push(event)
    let live: CoordinatorLiveReply[] = []
    for (const event of events) if (event.type !== 'committed') live = coordinatorStreamReply(live, event)
    const said = await stoppedStepText(rawStream(raw), id)
    const messages = stoppedMessages(completed, said, lastAssistantText(completed))
    // appendMessages attaches these trusted fields to each persisted assistant and the terminal marker.
    const rows = [{ position: 1, createdAt: at, message: { role: 'user', content: 'status?' } as ModelMessage },
      ...messages.map((message, index) => ({ position: index + 2, createdAt: at,
        message: { ...message, ...(message.role === 'assistant' ? { mikkaStreamId: id } : {}),
          ...(index === messages.length - 1 && message.role === 'assistant' ? { mikkaStopped: true } : {}) } as ModelMessage }))]
    const persisted = chatItems(rows).findLast(item => item.from === 'coordinator')!
    return { live: live[0], persisted, events }
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = previous
  }
}

for (const scoped of [false, true]) {
  for (const held of [false, true]) {
    test(`stopped projection trims the same text through the real live and persisted paths (scoped=${scoped}, held=${held})`, async () => {
      const result = await stoppedProjection(scoped, [{ type: 'text-delta', id: 't', text: '  Keep this \n' }], [], held)
      assert.equal(result.persisted.text, 'Keep this')
      assert.equal(result.live.text, result.persisted.text)
      assert.equal(result.persisted.streamId, id)
      assert.equal(result.persisted.stopped, true)
      if (held) assert.equal(result.events.findIndex(event => event.type === 'text'), result.events.findIndex(event => event.type === 'committed') - 1,
        'Stop never releases the saved-secret holdback before the committed boundary')
    })
  }
  test(`stopped projection retains completed steps and corrected tool positions after a retry (scoped=${scoped})`, async () => {
    const tool = { type: 'tool-call', toolCallId: 'search', toolName: 'web_search', input: { query: 'example' } }
    const result = await stoppedProjection(scoped, [
      { type: 'text-delta', id: 't', text: ' first \n' }, tool,
      { type: 'tool-result', toolCallId: 'search', toolName: 'web_search', output: {} },
      { type: 'finish-step' }, { type: 'start-step' }, { type: 'text-delta', id: 't', text: 'wrong' },
      { type: 'reset-step' }, { type: 'text-delta', id: 't', text: ' second \t' },
    ], [
      { role: 'assistant', content: [{ type: 'text', text: ' first \n' }, tool] } as ModelMessage,
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'search', toolName: 'web_search', output: { type: 'json', value: {} } }] },
    ])
    assert.equal(result.persisted.text, 'first\n\nsecond')
    assert.equal(result.live.text, result.persisted.text)
    assert.equal(result.events.find(event => event.type === 'tool')?.at, result.persisted.activity?.tools[0].at)
    assert.equal(result.persisted.activity?.tools[0].at, 'first'.length)
    assert.equal(result.live.text.includes('wrong'), false)
  })
  test(`stopped projection never exposes a partial quiet sentinel (scoped=${scoped})`, async () => {
    const result = await stoppedProjection(scoped, [{ type: 'text-delta', id: 't', text: QUIET_REPLY.slice(0, 4) }], [], false, true)
    assert.equal(result.live.text, '')
    assert.equal(result.persisted.text, '')
    assert.equal(result.persisted.streamId, id)
    assert.equal(result.persisted.stopped, true)
    assert.equal(result.events.some(event => event.type === 'text'), false)
  })
}

test('an empty stopped reply retains its own round identity and position without claiming an older reply', () => {
  const rows = [
    { position: 1, createdAt: at, message: { role: 'assistant', content: 'Older reply', mikkaStreamId: 'older:0' } as ModelMessage },
    { position: 2, createdAt: at, message: { role: 'assistant', content: '', mikkaStreamId: id, mikkaStopped: true } as ModelMessage },
  ]
  assert.deepEqual(chatItems(rows).map(item => [item.text, item.streamId, item.position, item.stopped]), [
    ['Older reply', 'older:0', 1, undefined], ['', id, 2, true],
  ])
  const unstopped = chatItems(rows.map(row => ({ ...row, message: { ...row.message, mikkaStopped: false } as ModelMessage & { mikkaStopped: boolean } })))
  assert.deepEqual(unstopped.map(item => [item.text, item.streamId, item.position]), [['Older reply', 'older:0', 1]])
})
