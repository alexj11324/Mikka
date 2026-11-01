import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { chatItems, promptMessages } from './context'
import { coordinatorStopToken, stoppedMessages, stoppedStepText } from './stop'
import type { CoordinatorWorkflowStreamPart } from './stream'

const parts = (...list: unknown[]) => new ReadableStream<CoordinatorWorkflowStreamPart>({ start(controller) { for (const part of list) controller.enqueue(part as CoordinatorWorkflowStreamPart); controller.close() } })
const at = new Date('2026-11-01T12:00:00Z')

test('the stop hook is named for the run that holds the chat', () => {
  assert.equal(coordinatorStopToken('wrun_1'), 'coordinator-stop:wrun_1')
})

test('stopped text is the model call in flight, up to the stop mark of its own turn', async () => {
  const said = await stoppedStepText(parts(
    { type: 'coordinator-turn-start', id: 'run:0', quietEligible: false },
    { type: 'reset-step' }, { type: 'text-delta', id: 't', text: 'An earlier turn' },
    { type: 'coordinator-turn-committed', id: 'run:0', through: 3, quiet: false },
    { type: 'coordinator-turn-start', id: 'run:1', quietEligible: false },
    { type: 'reset-step' }, { type: 'text-delta', id: 't', text: 'Checking.' },
    { type: 'finish-step' }, { type: 'start-step' },
    { type: 'reset-step' }, { type: 'text-delta', id: 't', text: 'The task is ' }, { type: 'text-delta', id: 't', text: 'still open' },
    { type: 'coordinator-turn-stopped', id: 'run:1' },
    { type: 'text-delta', id: 't', text: ' — never read' },
  ), 'run:1')
  assert.equal(said, 'The task is still open')
})

test('a stopped handoff turn that was only starting its quiet sentinel says nothing', async () => {
  const said = await stoppedStepText(parts(
    { type: 'coordinator-turn-start', id: 'run:0', quietEligible: true },
    { type: 'reset-step' }, { type: 'text-delta', id: 't', text: '[qui' },
    { type: 'coordinator-turn-stopped', id: 'run:0' },
  ), 'run:0')
  assert.equal(said, '')
})

test('stopped messages keep completed calls, add the words in flight once, and end on an assistant message', () => {
  const completed: ModelMessage[] = [{ role: 'assistant', content: 'Checking.' }]
  assert.deepEqual(stoppedMessages(completed, 'The task is', 'Checking.'), [...completed, { role: 'assistant', content: 'The task is' }])
  assert.deepEqual(stoppedMessages(completed, 'Checking.', 'Checking.'), completed, 'a stop as the call finished stores its words once')
  const tool: ModelMessage[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'list_issues', output: { type: 'json', value: [] } }] }]
  assert.deepEqual(stoppedMessages(tool, '', ''), [...tool, { role: 'assistant', content: '' }])
})

test('the chat shows a stopped reply with its words, and a stop before any word as its own stopped reply', () => {
  const rows = (messages: unknown[]) => messages.map((message, index) => ({ position: index + 1, message: message as ModelMessage, createdAt: at }))
  const partial = chatItems(rows([{ role: 'user', content: 'status?' }, { role: 'assistant', content: 'Checking.' }, { role: 'assistant', content: 'The task is', mikkaStopped: true }]))
  assert.deepEqual(partial.map(item => [item.from, item.text, item.stopped]), [['person', 'status?', undefined], ['coordinator', 'Checking.\n\nThe task is', true]])
  const silent = chatItems(rows([{ role: 'user', content: 'status?' }, { role: 'assistant', content: '', mikkaStopped: true }]))
  assert.deepEqual(silent.map(item => [item.from, item.text, item.stopped]), [['person', 'status?', undefined], ['coordinator', '', true]])
  // The empty mark is for the chat; the model never gets an empty message.
  assert.deepEqual(promptMessages(null, [{ position: 1, message: { role: 'user', content: 'status?' } }, { position: 2, message: { role: 'assistant', content: '' } }]).map(message => message.role), ['user'])
})
