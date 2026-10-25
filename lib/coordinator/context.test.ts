import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelMessage } from 'ai'
import { chatItems, compactionCut, COMPACT_AT_TOKENS, estimateTokens, eventPrompt, forgetNotes, instructionsWithMemory, KEEP_RECENT_TOKENS, MEMORY_MAX_CHARS, promptMessages, rememberNote, SUMMARY_PREFIX, type StoredMessage } from './context'

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

test('token estimate counts Chinese closer to a token a character', () => {
  assert.ok(estimateTokens([{ role: 'user', content: '你好世界你好世界' }]) > estimateTokens([{ role: 'user', content: 'hello wo' }]))
})

test('the summary leads the prompt', () => {
  const prompt = promptMessages('they prefer Codex', stored([{ role: 'user', content: 'hi' }]))
  assert.equal(prompt[0].role, 'user')
  assert.equal(prompt[0].content, `${SUMMARY_PREFIX}\n\nthey prefer Codex`)
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


test('uncertain and unknown action events tolerate missing input without declaring failure or decline', () => {
  for (const status of ['uncertain', 'unknown', undefined, null]) for (const input of [undefined, null]) {
    const prompt = eventPrompt({ kind: 'action_decided', issueId: null, runId: null, payload: { action: 'create_calendar_event', actionId: 'existing-proposal', status, input } })
    assert.match(prompt, /outcome.*unknown/)
    assert.match(prompt, /may already have happened/)
    assert.match(prompt, /do not automatically resend/)
    assert.doesNotMatch(prompt, /person declined|It did not happen|and it is done/)
  }
})
