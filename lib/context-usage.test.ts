import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chunkText, contextUsage, countChars, CONTEXT_SEGMENT_KEYS, CONTEXT_CHARS_SQL, CONVERSATION_CHUNK_KEYS,
  estimateTextTokens, estimateTokensFromCounts, PROMPT_BUDGET_TOKENS, PROMPT_MAX_CHARS,
} from './context-usage'

const brief = (task: string, rules: string) => `${task}\n\n${rules}`

test('a token is about four ASCII characters, and anything else one', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens('abcde'), 2)
  // Chinese runs close to a token a character, and is not divided by four.
  assert.equal(estimateTextTokens('你好世界'), 4)
  assert.ok(estimateTextTokens('你好世界') > estimateTextTokens('hello wo'))
  // The counts are the only input, and negative counts cannot subtract.
  assert.equal(estimateTokensFromCounts({ ascii: 8, other: 2 }), 4)
  assert.equal(estimateTokensFromCounts({ ascii: -8, other: 2 }), 2)
})

test('countChars separates ASCII from everything else', () => {
  assert.deepEqual(countChars('ab你'), { ascii: 2, other: 1 })
  // A multi-code-unit character is one character, as Postgres length() counts it.
  assert.deepEqual(countChars('😀'), { ascii: 0, other: 1 })
  assert.deepEqual(countChars(''), { ascii: 0, other: 0 })
})

test('the estimate says it is an estimate, and never claims a window or a threshold', () => {
  const usage = contextUsage({ prompt: brief('# Task', 'Host guidance'), task: '# Task', messages: [], chunks: [] })
  // A person must not be able to read this as a provider measurement.
  assert.equal(usage.estimated, true)
  // Mikka stores no context window and a task thread never folds: both stay null.
  assert.equal(usage.windowTokens, null)
  assert.equal(usage.compactAtTokens, null)
})

test('the brief and the conversation add up, with the task counted once', () => {
  const prompt = brief('# Fix the parser', 'Host guidance that is longer than the task itself.')
  const usage = contextUsage({ prompt, task: '# Fix the parser', messages: ['What about tabs?'], chunks: [] })
  // The brief's whole text is `promptUsed`, never the task twice.
  assert.equal(usage.promptUsed, estimateTextTokens(prompt))
  // The task is the person's words, so it belongs to the conversation.
  assert.equal(usage.segments.find(segment => segment.key === 'conversation')!.tokens,
    estimateTextTokens('# Fix the parser') + estimateTextTokens('What about tabs?'))
  // And the rest of the brief is the host's rules.
  assert.equal(usage.segments.find(segment => segment.key === 'rules')!.tokens,
    estimateTextTokens(prompt) - estimateTextTokens('# Fix the parser'))
})

test('the segments are a strict partition of used, so a screen never has to guess a gap', () => {
  const prompt = brief('# Task', 'Host guidance')
  const usage = contextUsage({
    prompt, task: '# Task',
    messages: ['hello', '你好'],
    chunks: [{ chunk: { type: 'text-delta', delta: 'an answer' } }, { chunk: { type: 'start' } }],
  })
  assert.equal(usage.segments.reduce((total, segment) => total + segment.tokens, 0), usage.used)
  // Largest first, so a bar reads left to right in the same order its legend does.
  const tokens = usage.segments.map(segment => segment.tokens)
  assert.deepEqual(tokens, [...tokens].sort((a, b) => b - a))
})

test('a segment with no text is absent, and every unreadable key is named instead of counted as zero', () => {
  // A run with no brief and nothing said yet: no measured segment at all.
  const empty = contextUsage({ prompt: '', task: '', messages: [], chunks: [] })
  assert.equal(empty.segments.length, 0)
  assert.equal(empty.used, 0)
  // All seven still account for themselves: measured or named, never silently dropped.
  const named = [...empty.segments.map(segment => segment.key), ...empty.unmeasured].sort()
  assert.deepEqual(named, [...CONTEXT_SEGMENT_KEYS].sort())
  assert.equal(new Set(named).size, CONTEXT_SEGMENT_KEYS.length)
})

test('the harness owns segments this host never stores, so they are unmeasured', () => {
  const usage = contextUsage({ prompt: brief('# Task', 'Host guidance'), task: '# Task', messages: [], chunks: [] })
  // The CLI's own system prompt and tool definitions, and the daemon's MCP and
  // environment sections, are not in agent_runs.prompt: claiming a number for
  // them would be inventing one, and counting them as zero would understate.
  for (const key of ['system', 'tools', 'mcp', 'environment', 'skills'] as const) assert.ok(usage.unmeasured.includes(key), key)
})

test('the budget is the brief cap in the same unit, not a context window', () => {
  const usage = contextUsage({ prompt: '# Task', task: '# Task', messages: [], chunks: [] })
  // lib/run-prompt.ts caps the brief at PROMPT_MAX_CHARS characters.
  assert.equal(usage.promptBudget, PROMPT_BUDGET_TOKENS)
  assert.equal(usage.promptBudget, Math.ceil(PROMPT_MAX_CHARS / 4))
  // A brief at the cap reads as exactly the budget.
  const full = contextUsage({ prompt: 'a'.repeat(PROMPT_MAX_CHARS), task: 'a'.repeat(PROMPT_MAX_CHARS), messages: [], chunks: [] })
  assert.equal(full.promptUsed, usage.promptBudget)
})

test('the conversation counts what the agent said, not the frames that carry no words', () => {
  assert.equal(chunkText({ type: 'text-delta', delta: 'hello' }), 'hello')
  assert.equal(chunkText({ type: 'reasoning-delta', delta: 'thinking' }), 'thinking')
  assert.equal(chunkText({ type: 'tool-output-available', output: 'a file' }), 'a file')
  assert.equal(chunkText({ type: 'tool-output-error', errorText: 'it failed' }), 'it failed')
  // Usage receipts, start/finish frames and run state say nothing the model reads back.
  assert.equal(chunkText({ type: 'data-usage', data: { inputTokens: 10 } }), '')
  assert.equal(chunkText({ type: 'start' }), '')
  assert.equal(chunkText({ type: 'finish' }), '')
  assert.equal(chunkText({ type: 'data-run-state', data: { state: 'running' } }), '')
  // A text delta with no string is a frame, not a word.
  assert.equal(chunkText({ type: 'text-delta' }), '')
})

test('the task is counted once even when it does not open the brief', () => {
  // A Factory check prepends its guidance and shifts `promptTaskStart`
  // (lib/factory/checks.ts), so the task is not always a prefix. It is still
  // inside the brief, so it must not be added on top of it.
  const prompt = 'Check guidance first.\n\n# Fix the parser\n\nHost rules'
  const usage = contextUsage({ prompt, task: '# Fix the parser', messages: [], chunks: [] })
  assert.equal(usage.promptUsed, estimateTextTokens(prompt))
  assert.equal(usage.used, estimateTextTokens(prompt))
  // And it belongs to the conversation, not to the host's rules.
  assert.equal(usage.segments.find(segment => segment.key === 'conversation')!.tokens, estimateTextTokens('# Fix the parser'))
  assert.equal(usage.segments.find(segment => segment.key === 'rules')!.tokens,
    estimateTextTokens(prompt) - estimateTextTokens('# Fix the parser'))
})

test('the model is reported when the run recorded one, and null when it did not', () => {
  assert.equal(contextUsage({ prompt: '# T', task: '# T', messages: [], chunks: [], model: 'gpt-6-luna' }).model, 'gpt-6-luna')
  // Historical runs froze no model: absent, never guessed.
  assert.equal(contextUsage({ prompt: '# T', task: '# T', messages: [], chunks: [] }).model, null)
  assert.equal(contextUsage({ prompt: '# T', task: '# T', messages: [], chunks: [], model: null }).model, null)
})

/**
 * The SQL twin is the one copy no type checker can compare with `countChars`,
 * so the two are pinned to each other here: same source text, same answer.
 */
test('the SQL counts the same characters countChars does, and over the same frames', () => {
  // The three chunk fields the SQL reads are exactly the ones chunkText returns.
  assert.deepEqual([...CONVERSATION_CHUNK_KEYS], ['delta', 'output', 'errorText'])
  for (const type of ['text-delta', 'reasoning-delta', 'tool-output-available', 'tool-output-error'] as const) {
    const chunk = { type, delta: 'a你b', output: 'a你b', errorText: 'a你b' }
    assert.ok(CONVERSATION_CHUNK_KEYS.some(key => chunkText(chunk) === chunk[key]), `${type} must be counted`)
  }
  // A frame whose text the SQL does not read must not count in TypeScript either.
  for (const chunk of [{ type: 'data-usage', delta: 'x', output: 'x', errorText: 'x' }, { type: 'start', delta: 'x' }]) {
    assert.equal(chunkText(chunk), '')
  }
  // `[^[:ascii:]]` strips exactly the characters countChars calls `other`, so
  // length(what is left) is the ASCII count and the difference is the rest.
  const text = 'a你b😀c'
  assert.deepEqual(countChars(text), { ascii: 3, other: 2 })
  const stripped = [...text].filter(char => char.charCodeAt(0) < 128).length
  assert.equal(stripped, 3)
  assert.equal([...text].length - stripped, 2)
  // And the query reads the three fields, over the run chain and the root brief.
  assert.match(CONTEXT_CHARS_SQL, /'text-delta','reasoning-delta'/)
  assert.match(CONTEXT_CHARS_SQL, /'tool-output-available'/)
  assert.match(CONTEXT_CHARS_SQL, /'tool-output-error'/)
  assert.match(CONTEXT_CHARS_SQL, /ANY\(\$1::uuid\[\]\)/)
  assert.match(CONTEXT_CHARS_SQL, /id = \$2/)
})

test('the query returns no text, so a cursor read stays small', () => {
  // The whole reason this counts in SQL: the byte budget a later read keeps
  // (tests/thread-detail-bytes.db.test.ts). No column may hand back prompt or
  // chunk text, only lengths.
  const selected = CONTEXT_CHARS_SQL.slice(CONTEXT_CHARS_SQL.indexOf('SELECT\n    (SELECT ascii'))
  for (const column of ['promptAscii', 'promptOther', 'taskAscii', 'taskOther', 'messageAscii', 'messageOther', 'conversationAscii', 'conversationOther']) {
    assert.match(selected, new RegExp(`AS "${column}"`))
  }
  // Every projected value is a length() or a count aggregate, never a bare column.
  assert.doesNotMatch(selected, /^\s*(?:prompt|text|chunk|txt|delta|output|errorText),?$/m)
  assert.match(selected, /length\(/)
})
