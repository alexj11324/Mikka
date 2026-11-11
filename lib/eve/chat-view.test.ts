import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EveMessage } from 'eve/client'
import { coordinatorAgentReplies } from './chat-view'
import { coordinatorAgentClient, coordinatorSendFailure } from './client'
import { ClientError } from 'eve/client'

test('native message parts retain tool ordering, reasoning, and lifecycle without another stream store', () => {
  const messages: EveMessage[] = [{ id: 'native-reply', role: 'assistant', metadata: { status: 'streaming', turnId: 'turn-a' }, parts: [
    { type: 'reasoning', id: 'thought', state: 'done', text: 'Compare the requested task.' },
    { type: 'text', id: 'before', state: 'done', text: 'Looking up the task.' },
    { type: 'tool', callId: 'call-a', kind: 'tool', stepIndex: 0, name: 'get_issue', label: 'Read task', state: 'completed', input: { issueId: 'issue-a' }, output: { title: 'Keep existing history' } },
    { type: 'text', id: 'after', state: 'streaming', text: ' Found it.' },
  ] }]
  const reply = coordinatorAgentReplies(messages)[0]
  assert.equal(reply.text, 'Looking up the task. Found it.')
  assert.equal(reply.tools?.[0].at, 'Looking up the task.'.length)
  assert.equal(reply.tools?.[0].state, 'done')
  assert.equal(reply.thinking?.text, 'Compare the requested task.')
  assert.equal(reply.committedThrough, undefined)
  assert.deepEqual(coordinatorAgentReplies(messages, ['native-reply']), [])
})

test('imported messages stay in the historical product reader, completed native messages stay until mirrored', () => {
  const messages: EveMessage[] = [
    { id: 'old', role: 'assistant', metadata: { imported: true, historyId: 'stored-a' }, parts: [{ type: 'text', text: 'Old history' }] },
    { id: 'new', role: 'assistant', metadata: { status: 'complete', turnId: 'turn-a' }, parts: [{ type: 'text', text: 'New reply' }] },
  ]
  assert.deepEqual(coordinatorAgentReplies(messages).map(reply => [reply.id, reply.text, reply.committedThrough]), [['new', 'New reply', 0]])
  assert.deepEqual(coordinatorAgentReplies(messages, ['eve:wrun_a:turn-a'], 'wrun_a'), [])
  assert.equal(coordinatorAgentReplies(messages, ['eve:wrun_a:turn-a'], 'wrun_b')[0].text, 'New reply')
})

test('native Client targets the standard protocol with the Bot on every request', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async input => { urls.push(String(input)); return Response.json({ ok: true, sessionId: 'wrun_bot' }) }
  try {
    const { session } = await coordinatorAgentClient('bot/a').sessions.create()
    assert.equal(session.id, 'wrun_bot')
    assert.match(urls[0], /\/api\/agents\/eve\/v1\/session/)
    assert.match(urls[0], /botId=bot%2Fa/)
  } finally { globalThis.fetch = original }
})

test('only closed public codes become send errors', () => {
  assert.deepEqual(coordinatorSendFailure(new ClientError(401, '{"code":"authRequired"}')), { kind: 'authRequired' })
  assert.deepEqual(coordinatorSendFailure(new ClientError(500, '{"error":"private provider response"}')), { kind: 'uncertain' })
  assert.deepEqual(coordinatorSendFailure(new ClientError(403, '{"code":"private provider response"}')), { kind: 'rejected', error: 'generic' })
})

test('tool previews are bounded, hidden controls and partial tool input stay out of the activity list', () => {
  const message: EveMessage = { id: 'tool-reply', role: 'assistant', parts: [
    { type: 'tool', callId: 'hidden', stepIndex: 0, kind: 'control', name: 'task_control', label: 'Task control', state: 'completed', hidden: true, output: 'hidden control' },
    { type: 'tool', callId: 'partial', stepIndex: 0, kind: 'tool', name: 'read', label: 'Read file', state: 'streaming', inputText: '{unfinished' },
    { type: 'tool', callId: 'done', stepIndex: 0, kind: 'tool', name: 'read', label: 'Read file', state: 'completed', input: { file: 'README.md' }, output: 'x'.repeat(5_000) },
  ] }
  const tools = coordinatorAgentReplies([message])[0].tools
  assert.deepEqual(tools?.map(tool => tool.call), ['partial', 'done'])
  assert.equal(tools?.[0].input, undefined)
  assert.equal(tools?.[1].output?.length, 2_000)
})
