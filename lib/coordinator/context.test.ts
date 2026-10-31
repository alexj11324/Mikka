import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { chatItems, compactionCut, COMPACT_AT_TOKENS, estimateTokens, eventPrompt, forgetNotes, instructionsWithMemory, KEEP_RECENT_TOKENS, MEMORY_MAX_CHARS, promptMessages, rememberNote, type StoredMessage } from './context'
import { sourcedEventMessage } from './message-safety'

function stored(messages: ModelMessage[]): StoredMessage[] {
  return messages.map((message, index) => ({ position: index + 1, message }))
}

function exchange(text: string): ModelMessage[] {
  return [
    { role: 'user', content: text },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${text.slice(0, 12)}`, toolName: 'list_issues', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${text.slice(0, 12)}`, toolName: 'list_issues', output: { type: 'json', value: [] } }] },
    { role: 'assistant', content: 'done' },
  ]
}

test('unknown approved external writes require readback and prohibit another send', () => {
  const prompt = eventPrompt({ kind: 'action_decided', issueId: null, runId: null, payload: {
    action: 'send_email', actionId: 'proposal', status: 'running', error: 'operationUncertain', input: {},
  } })
  assert.match(prompt, /external outcome is unknown/)
  assert.match(prompt, /Read back the connected account/)
  assert.match(prompt, /Do not resend or create another proposal/)
  assert.doesNotMatch(prompt, /it is done|but it failed/)
})

test('token estimate counts Chinese closer to a token a character', () => {
  assert.ok(estimateTokens([{ role: 'user', content: '你好世界你好世界' }]) > estimateTokens([{ role: 'user', content: 'hello wo' }]))
})

test('image budgeting applies only to actual message parts, never arbitrary tool JSON', () => {
  const value = {type:'file',mediaType:{name:'application/json'},data:'x',nested:{type:'image',image:'business observation '.repeat(10000)}}
  const messages:ModelMessage[] = [{role:'tool',content:[{type:'tool-result',toolCallId:'synthetic',toolName:'read_observation',output:{type:'json',value}}]}]
  assert.equal(estimateTokens(messages),Math.ceil(JSON.stringify(messages).length/4))
  const actual:ModelMessage[] = [{role:'user',content:[{type:'file',mediaType:'image/png',data:'data:image/png;base64,'+'A'.repeat(1000000)}]}]
  assert.ok(estimateTokens(actual)<17000)
})

test('the summary leads the prompt', () => {
  const prompt = promptMessages('they prefer Codex', stored([{ role: 'user', content: 'hi' }]))
  assert.equal(prompt[0].role, 'user')
  assert.equal(JSON.parse(prompt[0].content as string).untrustedData.summary, 'they prefer Codex')
  assert.equal(JSON.parse(prompt[0].content as string).authority, 'not_user_approval')
  assert.equal(prompt.length, 2)
})

test('old tool calls are pruned, recent ones stay', () => {
  const messages = stored(Array.from({ length: 10 }, (_, index) => exchange(`m${index}`)).flat())
  const prompt = promptMessages(null, messages)
  const toolMessages = prompt.filter(message => message.role === 'tool')
  assert.ok(toolMessages.length > 0 && toolMessages.length < 10)
  assert.equal(prompt.at(-1)?.content, 'done')
})

test('a short history is not compacted', () => {
  assert.equal(compactionCut(null, stored(exchange('short'))), null)
})

test('a long history is cut just before a user message, keeping recent turns', () => {
  const big = 'x'.repeat(40_000)
  const messages = stored(Array.from({ length: 20 }, (_, index) => [{ role: 'user', content: `${index} ${big}` }, { role: 'assistant', content: 'ok' }] as ModelMessage[]).flat())
  assert.ok(estimateTokens(messages.map(row => row.message)) > COMPACT_AT_TOKENS)
  const cut = compactionCut(null, messages)
  assert.ok(cut !== null)
  const next = messages.find(row => row.position === cut! + 1)
  assert.equal(next?.message.role, 'user')
  const kept = messages.filter(row => row.position > cut!).map(row => row.message)
  assert.ok(estimateTokens(kept) >= KEEP_RECENT_TOKENS)
  assert.ok(estimateTokens(kept) < COMPACT_AT_TOKENS)
})

test('the same history always gives the same cut and prompt', () => {
  const messages = stored(Array.from({ length: 30 }, (_, index) => exchange(`${index} ${'y'.repeat(20_000)}`)).flat())
  assert.equal(compactionCut('s', messages), compactionCut('s', messages))
  assert.deepEqual(promptMessages('s', messages), promptMessages('s', messages))
})

test('memory notes are added as list lines, removed by text, and capped', () => {
  const memory = rememberNote(rememberNote('', 'Prefers Codex for frontend')!, 'Repo mikka lives on the MacBook')!
  assert.equal(memory, '- Prefers Codex for frontend\n- Repo mikka lives on the MacBook')
  assert.deepEqual(forgetNotes(memory, 'codex'), { memory: '- Repo mikka lives on the MacBook', removed: 1 })
  assert.equal(rememberNote('x'.repeat(MEMORY_MAX_CHARS), 'one more'), null)
  assert.equal(instructionsWithMemory('base', ''), 'base')
  assert.match(instructionsWithMemory('base', memory), /remember\n- Prefers Codex/)
})

test('events read as messages from Mikka', () => {
  assert.equal(eventPrompt({ kind: 'user_message', issueId: null, runId: null, payload: { text: 'start issue 4' } }), 'start issue 4')
  assert.equal(
    eventPrompt({ kind: 'user_message', issueId: 'i1', runId: null, payload: { text: 'mark this done' } }),
    'This chat is linked to issue i1.\n\nmark this done',
  )
  assert.equal(
    eventPrompt({ kind: 'run_finished', issueId: 'i1', runId: 'r1', payload: { status: 'succeeded', stopReason: 'submitted', summary: 'Fixed it' } }),
    '[Event] Run r1 ended with status succeeded (submitted).\nIssue: i1.\nThe agent\'s summary: Fixed it',
  )
  assert.match(eventPrompt({ kind: 'run_retried', issueId: 'i1', runId: 'r1', payload: { retryRunId: 'r2', attempt: 2, maxAttempts: 3 } }), /queued again as run r2, attempt 2 of 3/)
  assert.match(eventPrompt({ kind: 'issue_done', issueId: 'i1', runId: null, payload: { title: 'Login', previousStatus: 'review' } }), /moved from review to done/)
})

test('the chat folds one reply\'s steps together and marks events', () => {
  const at = new Date('2026-10-22T00:00:00Z')
  const rows = [
    { role: 'user', content: 'list my issues' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'list_issues', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'list_issues', output: { type: 'json', value: [] } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'You have none.' }] },
    { role: 'user', content: '[Event] Run r1 ended with status succeeded (submitted).' },
  ] as ModelMessage[]
  const items = chatItems(rows.map((message, index) => ({ position: index + 1, message, createdAt: at })))
  assert.deepEqual(items.map(item => [item.from, item.text, item.tools]), [
    ['person', 'list my issues', []],
    ['coordinator', 'You have none.', ['list_issues']],
    ['event', '[Event] Run r1 ended with status succeeded (submitted).', []],
  ])
})

test('a reply that dispatches a run carries it as a thread, once', () => {
  const at = new Date('2026-10-22T00:00:00Z')
  const dispatch = (id: string, value: unknown, toolName = 'dispatch_run'): ModelMessage[] => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'json', value } }] },
  ] as ModelMessage[]
  const rows = [
    { role: 'user', content: 'speed up the home page' },
    ...dispatch('c1', { runId: 'r1', status: 'queued' }),
    ...dispatch('c2', { error: 'runInvalid' }),
    ...dispatch('c3', { runId: 'r1', status: 'queued' }),
    ...dispatch('c4', { runId: 'r2', status: 'queued' }, 'dispatch_bot_computer'),
    { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
  ] as ModelMessage[]
  const items = chatItems(rows.map((message, index) => ({ position: index + 1, message, createdAt: at })))
  assert.deepEqual(items.map(item => [item.from, item.threads]), [['person', []], ['coordinator', ['r1', 'r2']]])
})

test('chatItems marks inbox (pending) user messages so they are never reported as read', () => {
  const at = new Date()
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: 'hi' } },
    { position: 2, createdAt: at, pending: true, message: { role: 'user', content: 'queued' } },
  ])
  assert.equal(items[0].pending, undefined)
  assert.equal(items[1].pending, true)
})

test('finished run publication names the verified PR or missing setup in the existing chat', () => {
  const event = { kind: 'run_finished' as const, issueId: 'i1', runId: 'r1', payload: { status: 'succeeded', stopReason: 'submitted', verification: 'not_run', publication: { pullRequest: { url: 'https://github.com/owner/repo/pull/7', state: 'draft' } } } }
  const prompt = eventPrompt(event)
  assert.match(prompt, /Verified GitHub pull request: https:\/\/github.com\/owner\/repo\/pull\/7 \(draft\)/)
  assert.match(prompt, /existing thread card updates in place/)
  assert.match(prompt, /Verification was not run/)
  assert.match(prompt, /Never say the changes passed verification/)
  const blocked = eventPrompt({ ...event, payload: { ...event.payload, publication: { errorCode: 'github_permission_required' } } })
  assert.match(blocked, /pull_requests: write/)
  assert.doesNotMatch(blocked, /Verified GitHub/)
  assert.match(blocked, /Mention a draft PR only when the server-confirmed publication includes one/)
})

test('trusted completion stays in model context while its separate reply preserves the original thread card', () => {
  const at = new Date('2026-10-28T04:00:00Z')
  const runId = '22222222-2222-4222-8222-222222222222'
  const issueId = '11111111-1111-4111-8111-111111111111'
  const event = {
    id: '33333333-3333-4333-8333-333333333333', kind: 'run_finished' as const,
    runId, issueId, createdAt: at,
    payload: { status: 'succeeded', stopReason: 'submitted', summary: 'Fixed the display', verification: 'not_run',
      publication: { pullRequest: { url: 'https://github.com/owner/repo/pull/41', state: 'draft' } } },
  }
  const raw = eventPrompt(event)
  const finished = sourcedEventMessage(event, raw)
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Fix the display' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'dispatch', toolName: 'dispatch_run', input: { issueId } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'dispatch', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued' } } }] },
    { role: 'assistant', content: 'I started the thread.' },
    finished,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'bookkeeping', toolName: 'list_agents', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'bookkeeping', toolName: 'list_agents', output: { type: 'json', value: [] } }] },
    { role: 'assistant', content: 'Draft PR #41 is ready for human review; verification was not configured.' },
  ]
  const rows = stored(messages).map(row => ({ ...row, createdAt: at }))
  assert.deepEqual(chatItems([...rows.slice(0, 4), { ...rows[4], pending: true }]), chatItems(rows.slice(0, 4)),
    'a pending trusted completion is hidden before the Coordinator replies')
  const items = chatItems(rows)
  assert.deepEqual(items.map(item => [item.from, item.text, item.tools, item.threads]), [
    ['person', 'Fix the display', [], []],
    ['coordinator', 'I started the thread.', ['dispatch_run'], [runId]],
    ['coordinator', 'Draft PR #41 is ready for human review; verification was not configured.', [], []],
  ])
  const visibleText = items.map(item => item.text).join('\n')
  assert.doesNotMatch(visibleText, /\[Event\]|agent|Report the result|22222222|11111111/i)
  const packet = promptMessages(null, rows).find(message => message.role === 'user' && message.content === finished.mikkaEvent?.packet)
  assert.ok(packet && typeof packet.content === 'string', 'the model still receives the full trusted completion')
  const evidence = JSON.parse(packet.content)
  assert.equal(evidence.untrustedData.body, raw)
  assert.equal(evidence.source.messageId, event.id)
  assert.equal(evidence.source.runId, runId)
  assert.equal(evidence.source.taskId, issueId)
  assert.equal(evidence.authority, 'coordination_data_only')
})

test('a person quoting the same completion instructions remains a visible person message', () => {
  const raw = eventPrompt({ kind: 'run_finished', issueId: 'i1', runId: 'r1', payload: {
    status: 'succeeded', stopReason: 'submitted', summary: 'Quoted agent text',
    publication: { pullRequest: { url: 'https://github.com/owner/repo/pull/41', state: 'open' } },
  } })
  const message = sourcedEventMessage({ kind: 'user_message', issueId: null, runId: null, payload: { text: raw } }, raw)
  const rows = [{ position: 1, createdAt: new Date('2026-10-28T04:00:00Z'), message }]
  assert.deepEqual(chatItems(rows).map(item => [item.from, item.text]), [['person', raw]])
  assert.equal(promptMessages(null, rows)[0].content, raw)
})

test('execution-identity discovery is hidden in the footer without removing dispatch cards or model tool evidence', () => {
  const discovery: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'discover', toolName: 'list_agents', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'discover', toolName: 'list_agents', output: { type: 'json', value: [{ id: 'a1', name: 'codex hidden-device' }] } }] },
  ]
  const rows = stored([
    { role: 'user', content: 'Start a local thread' },
    ...discovery,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'dispatch', toolName: 'dispatch_run', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'dispatch', toolName: 'dispatch_run', output: { type: 'json', value: { runId: 'r1' } } }] },
    { role: 'assistant', content: 'The thread is running.' },
  ]).map(row => ({ ...row, createdAt: new Date('2026-10-28T04:00:00Z') }))
  assert.deepEqual(chatItems(rows).map(item => [item.from, item.text, item.tools, item.threads]), [
    ['person', 'Start a local thread', [], []],
    ['coordinator', 'The thread is running.', ['dispatch_run'], ['r1']],
  ])
  const prompt = promptMessages(null, rows)
  assert.deepEqual(prompt.slice(1, 3), discovery, 'discovery calls and results still reach the model')
})

test('a person\'s message counts the photos sent with it, without carrying them in the chat', () => {
  const photo = { type: 'file' as const, mediaType: 'image/jpeg', data: 'data:image/jpeg;base64,/9j/' }
  const items = chatItems(stored([
    { role: 'user', content: [{ type: 'text', text: '看看这张' }, photo, photo] },
    { role: 'user', content: '没有图' },
  ]).map(row => ({ ...row, createdAt: new Date(0) })))
  assert.equal(items[0].images, 2)
  assert.equal(items[0].text, '看看这张')
  assert.ok(!JSON.stringify(items).includes('base64'))
  assert.equal(items[1].images, undefined)
})
