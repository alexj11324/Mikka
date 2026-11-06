import assert from 'node:assert/strict'
import test from 'node:test'
import { explicitNewTaskArguments, explicitNewTaskComplete, explicitNewTaskEvidence, explicitNewTaskCleanupReceipts } from './explicit-submission.mjs'

const issueId = '10000000-0000-4000-8000-000000000001'
const runId = '10000000-0000-4000-8000-000000000002'
const personId = '10000000-0000-4000-8000-000000000003'
const replyId = '10000000-0000-4000-8000-000000000004'
const botId = '10000000-0000-4000-8000-000000000005'
const profileId = '10000000-0000-4000-8000-000000000006'
const submissionId = '10000000-0000-4000-8000-000000000007'
const text = 'Create a task for me (run it on Mikka Cloud): tiny file acceptance'
const chat = () => ({ working: false, error: null, items: [
  { id: personId, position: 1, from: 'person', text, threads: [] },
  { id: replyId, position: 2, from: 'coordinator', text: 'Task dispatched', threads: [runId], activity: { tools: [
    // Match the normal 200-character jsonb preview, including an incomplete tail.
    { call: 'create', name: 'create_issue', state: 'done', output: `{"id": "${issueId}", "title": "${'x'.repeat(220)}`.slice(0, 200) },
    { call: 'dispatch', name: 'dispatch_run', state: 'done', output: `{"botId": "${botId}", "runId": "${runId}", "status": "queued"}` },
  ] } },
] })

test('explicit new task uses the same structured destination and optional slots as NewTaskDialog', () => {
  assert.deepEqual(explicitNewTaskArguments(text, botId, submissionId, profileId),
    [text, undefined, botId, submissionId, { kind: 'cloud' }, undefined, undefined, undefined, profileId])
})

test('only a committed completed turn can trigger the single task-list read', () => {
  assert.equal(explicitNewTaskComplete(chat(), text, 0), true)
  for (const modify of [
    value => { value.working = true },
    value => { value.items[0].pending = true },
    value => { delete value.items[0].id },
    value => { delete value.items[1].id },
    value => { value.items.splice(1) },
  ]) { const value = chat(); modify(value); assert.equal(explicitNewTaskComplete(value, text, 0), false) }
  assert.equal(explicitNewTaskComplete(chat(), text, 1), false)
})

test('truncated create receipt still binds the exact new issue and displayed dispatch run', () => {
  const evidence = explicitNewTaskEvidence(chat(), text, 0, issueId)
  assert.equal(evidence.runId, runId)
  assert.equal(evidence.personMessageId, personId)
  assert.deepEqual(evidence.taskDestination, { kind: 'cloud' })
  assert.equal(evidence.create[0].toolCallId, 'create')
  assert.match(evidence.dispatch[0].outputSha256, /^[a-f0-9]{64}$/)
})

test('missing, foreign, alternative-dispatch and concurrent receipts cannot pass', () => {
  for (const modify of [
    value => { value.items[1].activity.tools[0].output = `Created ${issueId}` },
    value => { value.items[1].activity.tools[0].output = `{"id":"${profileId}"}` },
    value => { value.items[1].activity.tools[0].state = 'error' },
    value => { value.items[1].activity.tools[1].name = 'dispatch_bot_computer' },
    value => { value.items[1].threads = [] },
    value => { value.items.push({ id: submissionId, from: 'person', position: 3, text: 'Other work' }) },
    value => { value.error = 'turn_failed' },
  ]) { const value = chat(); modify(value); assert.throws(() => explicitNewTaskEvidence(value, text, 0, issueId), /^Error: issue1503_/) }
})

test('cleanup retains real creation and dispatch receipts before a completed turn or a later failure', () => {
  for (const state of [{ working: true }, { working: false, error: 'turn_failed' }]) {
    const value = { ...chat(), ...state }
    assert.deepEqual(explicitNewTaskCleanupReceipts(value, text, 0), { issueIds: [issueId], runIds: [runId] })
  }
  for (const modify of [
    value => { value.items[0].pending = true },
    value => { value.items[0].text = 'Other message' },
    value => { value.items.push({ id: submissionId, from: 'person', position: 3, text: 'Other work' }) },
    value => { value.items[1].activity.tools.forEach(tool => { tool.state = 'error' }) },
    value => { value.items[1].activity.tools[0].output = `Created ${issueId}`; value.items[1].activity.tools[1].output = `Run ${runId}` },
  ]) { const value = chat(); modify(value); assert.deepEqual(explicitNewTaskCleanupReceipts(value, text, 0), { issueIds: [], runIds: [] }) }
})
