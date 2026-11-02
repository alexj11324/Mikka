import assert from 'node:assert/strict'
import test from 'node:test'
import { botAttention } from './bot-mood'
import type { GroupIssue, ThreadOutcome } from './thread-groups'

type Extra = { botId?: string | null; issueId?: string | null; createdAt?: string; outcome?: ThreadOutcome | null }
const thread = (id: string, status: string, extra: Extra = {}) =>
  ({ id, status, botId: extra.botId === undefined ? 'bot' : extra.botId, issueId: extra.issueId ?? null, createdAt: extra.createdAt ?? '2026-10-28T10:00:00Z', outcome: extra.outcome ?? null })

test('raw status alone no longer decides: a failed run judged idle is not exclaim', () => {
  assert.equal(botAttention([thread('a', 'failed', { outcome: 'idle' })], 'bot', false), 'idle')
})

test('a thread waiting on you draws nothing on the face: no notify badge', () => {
  assert.equal(botAttention([thread('a', 'succeeded', { outcome: 'needs_input' })], 'bot', false), 'idle')
  assert.equal(botAttention([thread('a', 'waiting_input')], 'bot', false), 'idle')
})

test('a succeeded run judged blocked or failed is exclaim; judged done is idle', () => {
  assert.equal(botAttention([thread('a', 'succeeded', { outcome: 'blocked' })], 'bot', false), 'exclaim')
  assert.equal(botAttention([thread('a', 'stopped', { outcome: 'failed' })], 'bot', false), 'exclaim')
  assert.equal(botAttention([thread('a', 'succeeded', { outcome: 'done' })], 'bot', false), 'idle')
})

test('working first, then the newest row blocked', () => {
  assert.equal(botAttention([thread('a', 'running'), thread('b', 'waiting_input')], 'bot', false), 'thinking')
  assert.equal(botAttention([thread('a', 'running'), thread('b', 'succeeded', { outcome: 'done' })], 'bot', false), 'thinking')
  assert.equal(botAttention([thread('a', 'succeeded', { outcome: 'done' })], 'bot', true), 'thinking')
  // Latest activity first: an older blocked thread does not stay on the face.
  assert.equal(botAttention([thread('a', 'succeeded', { outcome: 'done' }), thread('b', 'failed', { outcome: 'failed' })], 'bot', false), 'idle')
})

test('a task folds into its newest thread, as in the right column', () => {
  const older = thread('old', 'succeeded', { issueId: 't', outcome: 'needs_input', createdAt: '2026-10-28T09:00:00Z' })
  const newer = thread('new', 'succeeded', { issueId: 't', outcome: 'done', createdAt: '2026-10-28T11:00:00Z' })
  assert.equal(botAttention([newer, older], 'bot', false), 'idle')
})

test('a closed task settles its thread', () => {
  const issue: GroupIssue = { status: 'done', metadata: { pullRequests: [] } }
  assert.equal(botAttention([thread('a', 'failed', { issueId: 't', outcome: 'failed' })], 'bot', false, () => issue), 'idle')
})

test('only the bot\'s own threads count', () => {
  assert.equal(botAttention([thread('a', 'waiting_input', { botId: 'other' }), thread('b', 'running', { botId: null })], 'bot', false), 'idle')
})
