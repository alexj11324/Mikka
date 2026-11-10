import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { chatItems, jsonbText, compactionCut, COMPACT_AT_TOKENS, estimateTokens, eventPrompt, forgetNotes, instructionsWithMemory, KEEP_RECENT_TOKENS, MEMORY_MAX_CHARS, promptMessages, rememberNote, type StoredMessage } from './context'
import { scheduleChatMessage } from '../schedules/chat-result'
import { modelMessage, pointsSwitchMessage, quotaSwitchMessage, sourcedEventMessage } from './message-safety'
import { runCompletionObservations } from './run-completion-observation'
import { restoreChatToolMetadata } from './chat-tool-metadata'

test('scheduled results keep their useful body separate from adjacent replies, without protocol receipts', () => {
  const at = new Date('2030-01-01T00:00:00Z')
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'assistant', content: 'The reminder is set.' } },
    { position: 2, createdAt: at, message: scheduleChatMessage('Daily check', 'succeeded', { text: 'Check the release notes.' }) },
    { position: 3, createdAt: at, message: { role: 'assistant', content: 'Another reply.' } },
  ])
  assert.deepEqual(items.map(item => item.text), ['The reminder is set.', 'Check the release notes.', 'Another reply.'])
  assert.doesNotMatch(JSON.stringify(items), /Schedule |occurrence|operation|succeeded/)
})

test('failed, skipped and cancelled schedules are friendly event data rather than raw error codes', () => {
  const at = new Date('2030-01-01T00:00:00Z')
  for (const status of ['failed', 'skipped', 'cancelled']) {
    const [item] = chatItems([{ position: 1, createdAt: at, message: scheduleChatMessage('Daily check', status, null) }])
    assert.equal(item.from, 'event')
    assert.equal(item.text, '')
    assert.deepEqual(item.line, { kind: 'scheduleRan', runId: null, issueId: null, title: 'Daily check', status })
  }
})

test('a scheduled task snapshot retains its exact task and status as localizable event data', () => {
  const task = { id: '00000000-0000-4000-8000-000000000179', title: 'Release', status: 'review' }
  const [item] = chatItems([{ position: 1, createdAt: new Date(), message: scheduleChatMessage('Daily check', 'succeeded', task) }])
  assert.equal(item.text, `[[issue:${task.id}]]`)
  assert.deepEqual(item.line, { kind: 'issueSnapshot', runId: null, issueId: task.id, title: 'Release', status: 'review' })
})

test('words resembling a scheduler protocol do not turn an ordinary reply into a host result', () => {
  const content = '[Schedule example; occurrence example; operation example] Example: succeeded\nKeep this quoted example.'
  const [item] = chatItems([{ position: 1, createdAt: new Date(), message: { role: 'assistant', content } }])
  assert.equal(item.from, 'coordinator')
  assert.equal(item.text, content)
})

test('watchdog blocker exposes the actual host facts and never invents a successful handoff', () => {
  const prompt = eventPrompt({ kind: 'run_report', issueId: 'issue', runId: null, payload: {
    source: 'task_watchdog', taskId: 'task', requestEpoch: 'epoch', reason: 'Credential revoked on the remaining device', handoffEventId: 'handoff', handoffDigest: 'digest',
  } })
  assert.match(prompt, /Credential revoked/)
  assert.match(prompt, /epoch/)
  assert.match(prompt, /Do not replay uncertain/)
  assert.doesNotMatch(prompt, /undefined/)
})

function stored(messages: ModelMessage[]): StoredMessage[] {
  return messages.map((message, index) => ({ position: index + 1, message }))
}

test('a legacy cached invalid tool activity requires a fresh bounded projection',()=>{
  const items=[{position:2,from:'coordinator',activity:{tools:[{call:'bad',name:'none',state:'error' as const}]}}]
  const rows=[
    {position:2,parts:[{type:'tool-call' as const,ordinal:1,toolCallId:'bad',toolName:'none'}]},
    {position:3,parts:[{type:'tool-result' as const,ordinal:1,toolCallId:'bad',status:'error' as const,mikkaInvalidToolCall:true as const}]},
  ]
  assert.equal(restoreChatToolMetadata(items,rows,3,3),undefined)
})

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

test('a stored reply carries the stream it was first shown from, so the chat keeps that row when it is stored', () => {
  const at = new Date('2026-10-22T00:00:00Z')
  const rows = [
    { role: 'user', content: 'what is next?' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c0', toolName: 'record_attention', input: {} }], mikkaStreamId: 'wrun_1:0' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'list_issues', input: {} }], mikkaStreamId: 'wrun_1:1' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'list_issues', output: { type: 'json', value: [] } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Nothing open.' }], mikkaStreamId: 'wrun_1:1' },
    { role: 'assistant', content: [{ type: 'text', text: 'Anything else?' }], mikkaStreamId: 'wrun_1:2' },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: [{ type: 'text', text: 'Any time.' }] },
  ] as unknown as ModelMessage[]
  const items = chatItems(rows.map((message, index) => ({ position: index + 1, message, createdAt: at })))
  // A hidden tool shows nothing; the first tool or text that shows is the stream the person watched.
  assert.deepEqual(items.map(item => [item.from, item.text, item.streamId ?? null]), [
    ['person', 'what is next?', null],
    ['coordinator', 'Nothing open.\n\nAnything else?', 'wrun_1:1'],
    ['person', 'thanks', null],
    ['coordinator', 'Any time.', null],
  ])
})

test('a stored reply keeps its tools, how each ended and their previews, and whether it thought', () => {
  const at = new Date('2026-10-22T00:00:00Z')
  const compact = [
    { role: 'user', content: 'make a task and start it' },
    { role: 'assistant', content: [{ type: 'reasoning', chars: 120 }, { type: 'tool-call', toolCallId: 'c1', toolName: 'create_issue', inputPreview: '{"title": "Fix login"}', target: 'Fix login' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'record_attention' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'create_issue', status: 'done', outputPreview: '{"id": "i1"}' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'dispatch_run', inputPreview: '{"issueId": "i1"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c3', toolName: 'dispatch_run', status: 'error', outputPreview: 'no device' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c4', toolName: 'web_search' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Made it; the thread could not start.' }] },
  ] as unknown as ModelMessage[]
  const [, reply] = chatItems(compact.map((message, index) => ({ position: index + 1, message, createdAt: at })))
  assert.equal(reply.text, 'Made it; the thread could not start.')
  assert.deepEqual(reply.activity, { thought: true, reasoningAt: [2], tools: [
    { call: 'c1', name: 'create_issue', state: 'done', displayName: 'Create issue', target: 'Fix login', input: '{"title": "Fix login"}', output: '{"id": "i1"}', at: 0 },
    { call: 'c3', name: 'dispatch_run', state: 'error', displayName: 'Dispatch run', input: '{"issueId": "i1"}', output: 'no device', at: 0 },
    // No result stored yet: still running.
    { call: 'c4', name: 'web_search', state: 'running', displayName: 'Web search', at: 0 },
  ] })
  // Full stored messages (not the compact projection) read the same way.
  const full = chatItems([
    { position: 1, createdAt: at, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'list_issues', input: { query: 'login' } }] } as ModelMessage },
    { position: 2, createdAt: at, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'list_issues', output: { type: 'error-text', value: 'boom' } }] } as ModelMessage },
  ])
  assert.deepEqual(full[0].activity?.tools, [{ call: 'c1', name: 'list_issues', state: 'error', displayName: 'List issues', target: 'login', errorCode: 'boom', input: '{"query": "login"}', output: 'boom', at: 0 }])
  // A call's words come whole, apart from the cut input preview: from the compact projection's quotePreview, or the full input.
  const note = 'Reproduce the redirect loop and fix it. '.repeat(8).trim()
  const quoted = chatItems([
    { position: 1, createdAt: at, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', inputPreview: jsonbText({ note }).slice(0, 200), quotePreview: note }] } as unknown as ModelMessage },
    { position: 2, createdAt: at, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'dispatch_run', input: { issueId: 'i1', note } }] } as ModelMessage },
  ])
  assert.deepEqual(quoted[0].activity?.tools.map(tool => tool.quote), [note, note])
  // Words said before a tool ran stay above it: its `at` is the reply's text so far.
  const spoken = chatItems([
    { position: 1, createdAt: at, message: { role: 'assistant', content: [{ type: 'text', text: 'I will make the task first.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'create_issue', input: {} }] } as ModelMessage },
    { position: 2, createdAt: at, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'create_issue', output: { type: 'json', value: {} } }] } as ModelMessage },
    { position: 3, createdAt: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }, { type: 'tool-call', toolCallId: 'c2', toolName: 'list_issues', input: {} }] } as ModelMessage },
  ])
  assert.equal(spoken[0].text, 'I will make the task first.\n\nDone.')
  assert.deepEqual(spoken[0].activity?.tools.map(tool => tool.at), ['I will make the task first.'.length, spoken[0].text.length])
  // Encrypted or empty reasoning: it thought, but there is nothing to open.
  const sealed = chatItems([{ position: 1, createdAt: at, message: { role: 'assistant', content: [{ type: 'reasoning', chars: 0 }, { type: 'text', text: 'Done.' }] } as unknown as ModelMessage }])
  assert.deepEqual(sealed[0].activity, { tools: [], thought: true })
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

test('a failed message retried with 重新发送 is left out; the new attempt carries its own failure', () => {
  const at = new Date()
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: '帮我看看 CI', mikkaFailure: 'backend_unavailable', mikkaRetried: true } as unknown as ModelMessage },
    { position: 2, createdAt: at, message: { role: 'user', content: '帮我看看 CI', mikkaFailure: 'backend_unavailable' } as unknown as ModelMessage },
  ])
  assert.deepEqual(items.map(item => [item.position, item.text, item.failure?.kind ?? null]), [[2, '帮我看看 CI', 'subscription']])
})

test('a failed welcome shows on the Bot\'s side with its reason, for every error, until a reply follows', () => {
  const at = new Date()
  const welcome = (mikkaFailure?: string) => ({ position: 1, createdAt: at, message: { role: 'user', content: '[Welcome] The person has just opened their chat with you for the first time.', ...(mikkaFailure ? { mikkaFailure } : {}) } as unknown as ModelMessage })
  // Billing refused it, the subscription refused it, or the turn just failed: each one a Bot-side item, never hidden.
  for (const [error, kind] of [['Error: verification_required', 'hosted'], ['backend_unavailable', 'subscription'], ['socket hang up', 'failed']] as const) {
    const items = chatItems([welcome(error)])
    assert.deepEqual(items.map(item => [item.from, item.text, item.welcome, item.failure?.kind]), [['coordinator', '', true, kind]], error)
  }
  // No failure: the welcome request stays out of the chat, as before.
  assert.deepEqual(chatItems([welcome()]), [])
  // 重试 worked: the reply stands for it, and the welcome failure is gone.
  const answered = chatItems([welcome('Error: verification_required'), { position: 2, createdAt: at, message: { role: 'assistant', content: '你好，我是你的 Bot。' } }])
  assert.deepEqual(answered.map(item => [item.from, item.text, item.welcome ?? null]), [['coordinator', '你好，我是你的 Bot。', null]])
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

test('a report-only run does not claim that separate Factory verification was absent', () => {
  const prompt = eventPrompt({ kind: 'run_finished', issueId: 'i1', runId: 'review-1', payload: {
    status: 'succeeded', stopReason: 'submitted', runKind: 'acceptance', verification: 'not_run',
    summary: 'Read-only review executed npm test and a byte-equality check.',
  } })
  assert.match(prompt, /This run's host post-run verifier was not run/)
  assert.match(prompt, /does not describe commands called by the Agent or separate Factory checks/)
  assert.doesNotMatch(prompt, /Verification was not run: no verification command is configured/)
})

test('unrelated and differently scoped inbox events cause no observation read', async () => {
  const executor = { execute: async () => { throw new Error('Unexpected database read') } } as never
  const scope = { userId: 'owner', botId: 'bot' }
  const event = { ...scope, runId: 'run', issueId: 'issue', kind: 'run_finished' }
  assert.equal((await runCompletionObservations(executor, scope, [
    { ...event, kind: 'user_message' }, { ...event, userId: 'peer' },
    { ...event, botId: 'other-bot' }, { ...event, runId: null },
  ])).size, 0)
})

test('a blocked predecessor notification carries the accepted repository handoff and current task', () => {
  const event = { kind: 'run_finished' as const, issueId: 'issue', runId: 'old', payload: {
    status: 'stopped', stopReason: 'blocked', summary: 'Selected another repository.', verification: 'not_run',
  } }
  const prompt = eventPrompt(event, {
    observedAt: '2026-11-03T23:07:28Z', runId: 'old', postRunVerify: { status: 'not_run' },
    factory: { taskId: 'task', stage: 'execute', status: 'running', revision: 5, attemptId: 'attempt-next', requestEpoch: 'request-1',
      runAttempt: { id: 'attempt-old', stage: 'execute', status: 'blocked', requestEpoch: 'request-1' }, candidate: null },
    checks: [], publication: null,
    repositoryHandoffs: [{ previousRunId: 'old', nextRunId: 'next', nextStatus: 'running',
      from: 'https://github.com/example/wrong.git', to: 'https://github.com/example/correct.git', previousHead: 'a'.repeat(40) }],
  })
  assert.match(prompt, /Run old ended with status stopped \(blocked\)/, 'original terminal history remains visible')
  assert.match(prompt, /Current host observation/)
  assert.match(prompt, /"nextRunId":"next","nextStatus":"running"/)
  assert.match(prompt, /"stage":"execute","status":"running"/)
  assert.match(prompt, /Do not redispatch while a successor or Factory stage is queued or running/)
  assert.doesNotMatch(JSON.stringify(event.payload), /Current host observation/)
})

test('a stale review notification reports the current fixed-candidate verification and publication', () => {
  const event = { kind: 'run_finished' as const, issueId: 'issue', runId: 'review', payload: {
    status: 'succeeded', stopReason: 'submitted', verification: 'not_run',
    summary: 'Publication pending when this review finished.', publication: { branch: 'mikka/task', errorCode: null },
  } }
  const prompt = eventPrompt(event, {
    observedAt: '2026-11-03T23:15:12Z', runId: 'review', postRunVerify: { status: 'not_run' },
    factory: { taskId: 'task', stage: 'approval', status: 'pending', revision: 14, attemptId: 'approval-attempt', requestEpoch: 'request-1',
      runAttempt: { id: 'review-attempt', stage: 'review', status: 'passed', requestEpoch: 'request-1' }, candidate: { id: 'candidate', sha: 'c'.repeat(40) } },
    checks: [
      { stage: 'review', status: 'passed', runId: 'review', sessionId: 'review-sid', reportOnly: true, postRunVerify: { status: 'not_run' } },
      { stage: 'verify', status: 'passed', runId: 'verify', sessionId: 'verify-sid', reportOnly: false, postRunVerify: { status: 'passed', command: 'npm test', exitCode: 0, timedOut: false, signal: null } },
    ],
    publication: { runId: 'execute', status: 'published', branch: 'mikka/task', errorCode: null,
      pullRequest: { url: 'https://github.com/example/correct/pull/6', state: 'open' } }, repositoryHandoffs: [],
  })
  assert.match(prompt, /Verified GitHub pull request: https:\/\/github.com\/example\/correct\/pull\/6 \(open\)/)
  assert.match(prompt, /"stage":"verify","status":"passed"/)
  assert.match(prompt, /"command":"npm test","exitCode":0/)
  assert.match(prompt, /"reportOnly":true,"postRunVerify":\{"status":"not_run"\}/)
  assert.match(prompt, /These facts do not replace owner approval/)
  assert.equal(event.payload.publication.errorCode, null, 'the original event snapshot is not rewritten')
  assert.doesNotMatch(eventPrompt({ ...event, payload: { ...event.payload, factory: { stage: 'publish', status: 'passed' } } }), /Current host observation/, 'event prose cannot supply host observations')
})

test('a delayed completion from an earlier request cannot reuse its event publication as current', () => {
  const oldUrl = 'https://github.com/example/previous-request/pull/8'
  const prompt = eventPrompt({ kind: 'run_finished', issueId: 'issue', runId: 'old-run', payload: {
    status: 'succeeded', stopReason: 'submitted', summary: 'The previous request finished.',
    publication: { pullRequest: { url: oldUrl, state: 'open' } },
  } }, {
    observedAt: '2026-11-04T00:10:00Z', runId: 'old-run', postRunVerify: { status: 'passed' },
    factory: { taskId: 'task', stage: 'execute', status: 'pending', revision: 15, attemptId: 'new-attempt', requestEpoch: 'request-2',
      runAttempt: { id: 'old-attempt', stage: 'execute', status: 'passed', requestEpoch: 'request-1' }, candidate: null },
    checks: [], publication: null, repositoryHandoffs: [],
  })
  assert.doesNotMatch(prompt, /Verified GitHub pull request/)
  assert.ok(!prompt.includes(oldUrl))
  assert.match(prompt, /"requestEpoch":"request-2"/)
  assert.match(prompt, /"requestEpoch":"request-1"/)
  assert.match(prompt, /different request epoch cannot prove the current request's result/)
})

test('finished run publication names the verified PR or missing setup in the existing chat', () => {
  const event = { kind: 'run_finished' as const, issueId: 'i1', runId: 'r1', payload: { status: 'succeeded', stopReason: 'submitted', verification: 'not_run', publication: { pullRequest: { url: 'https://github.com/owner/repo/pull/7', state: 'draft' } } } }
  const prompt = eventPrompt(event)
  assert.match(prompt, /Verified GitHub pull request: https:\/\/github.com\/owner\/repo\/pull\/7 \(draft\)/)
  assert.match(prompt, /existing thread card updates in place/)
  assert.match(prompt, /This run's host post-run verifier was not run/)
  // The fact goes to the Coordinator; whether it needs the person's review is the model's judgment, not a fixed instruction.
  assert.doesNotMatch(prompt, /needs human review/)
  assert.match(prompt, /Do not claim verification passed from this field alone/)
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

test('legacy SDK invalid calls pair by id without hiding valid calls with a reused name or id',()=>{
  const rows:ModelMessage[]=[
    {role:'assistant',content:[{type:'tool-call',toolCallId:'reused',toolName:'registered',input:{}}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'reused',toolName:'registered',output:{type:'json',value:{ok:true}}}]},
    {role:'assistant',content:[{type:'tool-call',toolCallId:'bad',toolName:'registered',input:{}}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'bad',toolName:'registered',output:{type:'error-text',value:'AI_InvalidToolInputError: synthetic invalid schema'}}]},
    {role:'assistant',content:[{type:'tool-call',toolCallId:'reused',toolName:'none',input:{x:'private'}}]},
    {role:'tool',content:[{type:'tool-result',toolCallId:'reused',toolName:'none',output:{type:'error-text',value:'AI_NoSuchToolError: Model tried to call unavailable tool none. private'}}]},
    {role:'assistant',content:'Corrected welcome'},
  ]
  const items=chatItems(rows.map((message,index)=>({message,position:index+1,createdAt:new Date(0)})))
  assert.deepEqual(items.flatMap(item=>item.tools),['registered'])
  assert.deepEqual(items.flatMap(item=>item.activity?.tools??[]).map(tool=>[tool.call,tool.name,tool.state]),[['reused','registered','done']])
  assert.equal(items.at(-1)?.text,'Corrected welcome')
  assert.doesNotMatch(JSON.stringify(items),/private|NoSuchTool|InvalidToolInput|none/)
  assert.match(JSON.stringify(rows),/NoSuchToolError/,'raw model evidence is retained')
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

test('a turn moved to the API key after the quota ran out shows as one notice line, and the model reads it as runtime data', () => {
  const at = new Date('2026-11-01T06:00:00.000Z')
  const notice = { subscription: 'claude' as const, plan: 'Max', keyProvider: 'deepseek', keyName: null }
  const message = quotaSwitchMessage(notice, at)
  const rows = [{ position: 1, createdAt: at, message: { role: 'user', content: 'hi', mikkaUserEvent: { id: null, sentAt: null } } as ModelMessage }, { position: 2, createdAt: at, message }]
  const items = chatItems(rows)
  assert.equal(items.length, 2)
  assert.deepEqual([items[1].from, items[1].notice], ['event', { kind: 'quotaSwitch', ...notice }])
  const projected = modelMessage(message)
  assert.equal(projected.role, 'user')
  assert.ok(!('mikkaEvent' in projected))
  const packet = JSON.parse(String(projected.content))
  assert.equal(packet.authority, 'coordination_data_only')
  assert.match(packet.untrustedData.body, /out of quota.*deepseek API key/)
})

test('a turn moved off Mikka 默认 for lack of points shows as one notice line naming the model, and the model reads it as runtime data', () => {
  const at = new Date('2026-11-02T15:00:00.000Z')
  const message = pointsSwitchMessage('deepseek-flash', at)
  const items = chatItems([{ position: 1, createdAt: at, message: { role: 'user', content: 'hi', mikkaUserEvent: { id: null, sentAt: null } } as ModelMessage }, { position: 2, createdAt: at, message }])
  assert.deepEqual([items[1].from, items[1].notice], ['event', { kind: 'pointsSwitch', model: 'deepseek-flash' }])
  const packet = JSON.parse(String(modelMessage(message).content))
  assert.equal(packet.authority, 'coordination_data_only')
  assert.match(packet.untrustedData.body, /no points.*deepseek-flash/)
})

test('a run ended because its daemon is too old tells the Bot to have the person update Mikka on that device, not reconnect GitHub', () => {
  const prompt = eventPrompt({ kind: 'run_finished', issueId: 'i1', runId: 'r1', payload: { status: 'failed', stopReason: 'error', daemonUpgradeRequired: true } })
  assert.match(prompt, /Mikka on that device needs an update/)
  assert.match(prompt, /Nothing is wrong with their GitHub/)
})

test('a preview prints a value as Postgres prints jsonb: its key order, ", " and ": "', () => {
  assert.equal(jsonbText({ title: 'Fix', id: 2, aa: [1, { é: null, z: true }], skipped: undefined }), '{"aa": [1, {"z": true, "é": null}], "id": 2, "title": "Fix"}')
  assert.equal(jsonbText('text'), '"text"')
})

test('a turn that says what it is about to do, calls a tool and then answers is one Coordinator message, the opening first', () => {
  const at = new Date('2026-11-02T22:00:00Z')
  const rows: ModelMessage[] = [
    { role: 'user', content: '派发任务，给 Mikka_test 写一个简单的 README' },
    { role: 'assistant', content: [{ type: 'text', text: '我先建一个任务，再派给 Claude Code 写 README。' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'dispatch_run', input: { repo: 'Mikka_test' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'dispatch_run', output: { type: 'json', value: { runId: '00000000-0000-4000-8000-000000000061' } } }] },
    { role: 'assistant', content: [{ type: 'text', text: '已经派出去了，写好后告诉你。' }] },
  ]
  const items = chatItems(rows.map((message, index) => ({ position: index + 1, message, createdAt: at })))
  assert.deepEqual(items.map(item => [item.from, item.text]), [
    ['person', '派发任务，给 Mikka_test 写一个简单的 README'],
    ['coordinator', '我先建一个任务，再派给 Claude Code 写 README。\n\n已经派出去了，写好后告诉你。'],
  ])
  assert.deepEqual(items[1].threads, ['00000000-0000-4000-8000-000000000061'])
})
