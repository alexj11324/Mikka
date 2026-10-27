import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatItems, eventPrompt } from './context'
import { ATTENTION_THRESHOLD, eventsForInbox, ruleTier, tierFromDecision, triageQuestions, triageState } from './triage'
import { briefingEvent } from '@/lib/coordinator-events'

const run = (payload: Record<string, unknown>) => ({ kind: 'run_finished' as const, payload: { stopReason: 'submitted', ...payload } })

test('clear cases follow the rules', () => {
  assert.equal(ruleTier({ kind: 'user_message', payload: { text: 'hi' } }), 'attention')
  assert.equal(ruleTier({ kind: 'issue_done', payload: { title: 'x' } }), 'background')
  assert.equal(ruleTier({ kind: 'run_retried', payload: { retryRunId: 'r2', attempt: 2, maxAttempts: 3 } }), 'background')
  assert.equal(ruleTier(run({ status: 'failed' })), 'attention')
  assert.equal(ruleTier(run({ status: 'cancelled' })), 'background')
  assert.equal(ruleTier(run({ status: 'stopped' })), 'background')
  assert.equal(ruleTier(run({ status: 'succeeded', summary: null })), 'result')
  assert.equal(ruleTier(run({ status: 'succeeded', summary: '  ' })), 'result')
})

test('a success with a summary goes to the decision model', () => {
  assert.equal(ruleTier(run({ status: 'succeeded', summary: 'Fixed it, but could not run the tests' })), null)
  assert.deepEqual(triageState(run({ status: 'succeeded', summary: 'Done' })), { status: 'succeeded', stopReason: 'submitted', agentSummary: 'Done' })
})

test('the model\'s probability picks attention or result', () => {
  assert.equal(tierFromDecision(ATTENTION_THRESHOLD), 'attention')
  assert.equal(tierFromDecision(0.9), 'attention')
  assert.equal(tierFromDecision(0.2), 'result')
})

test('the tier reaches the Coordinator but not the chat', () => {
  const text = eventPrompt({ kind: 'run_finished', issueId: null, runId: 'r1', payload: { status: 'failed', stopReason: 'error' }, tier: 'attention' })
  assert.match(text, /\nTriage: this needs the person/)
  const [item] = chatItems([{ position: 1, createdAt: new Date(), message: { role: 'user', content: text } }])
  assert.equal(item.text, '[Event] Run r1 ended with status failed (error).')
  assert.doesNotMatch(eventPrompt({ kind: 'issue_done', issueId: 'i1', runId: null, payload: { title: 'Login', previousStatus: 'review' }, tier: 'result' }), /Triage/)
})

test('a waking message reaches a batch ahead of an older background backlog', () => {
  const background = Array.from({ length: 500 }, (_, index) => ({ id: `done-${index}`, createdAt: new Date(index) }))
  const message = { id: 'message', createdAt: new Date(500) }
  const batch = eventsForInbox([message], background, 50)

  assert.equal(batch.length, 50)
  assert.ok(batch.includes(message))
  assert.deepEqual(batch, [...batch].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
})

test('worker events: questions and blocks need the person, reports go to the model', () => {
  assert.equal(ruleTier({ kind: 'run_question', payload: { question: 'Drop the old table?' } }), 'attention')
  assert.equal(ruleTier({ kind: 'run_blocked', payload: { reason: 'No database access' } }), 'attention')
  assert.equal(ruleTier({ kind: 'run_report', payload: { text: ' ' } }), 'background')
  const report = { kind: 'run_report' as const, payload: { text: 'Migrated the users table' } }
  assert.equal(ruleTier(report), null)
  assert.deepEqual(triageState(report), { agentProgressNote: 'Migrated the users table' })
  assert.match(triageQuestions(report)[0].instructions, /progress note/)
  assert.equal(triageQuestions(report)[0].type, 'predicate')
  assert.equal(tierFromDecision(0.9, 'run_report'), 'attention')
  assert.equal(tierFromDecision(0.1, 'run_report'), 'background')
})

test('a worker question tells the Coordinator to relay the answer', () => {
  const text = eventPrompt({ kind: 'run_question', issueId: null, runId: 'r2', payload: { question: 'Keep v1?', options: ['Yes', 'No'] }, tier: 'attention' })
  assert.match(text, /asks the person: Keep v1\?\nOptions: Yes \/ No\n.*send_to_run/)
})

test('the morning briefing is pushed to the person once a day', () => {
  const event = briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'daily', total: 4, counts: { gmail: 3, linear: 1 } }, [
    { suggestionId: 's1', source: 'linear', action: 'handle', title: 'Fix login', actor: 'Dana', url: 'https://linear.app/x/issue/MIK-9', required: true },
    { suggestionId: 's2', source: 'gmail', action: 'reply', title: 'Thursday agenda', actor: null, url: null, required: false },
  ])
  assert.equal(event.dedupeKey, 'daily_briefing:u1:2026-10-27:daily')
  assert.notEqual(briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'first', total: 1, counts: {} }, []).dedupeKey, event.dedupeKey)
  const tier = ruleTier(event)
  assert.equal(tier, 'attention')
  const prompt = eventPrompt({ ...event, tier })
  assert.match(prompt, /^\[Event\] Daily briefing for 2026-10-27\.\nIt is 08:00 for the person\. 4 item\(s\)/)
  assert.match(prompt, /gmail 3, linear 1/)
  assert.match(prompt, /- linear · handle · assigned to them: "Fix login" from Dana \(https:\/\/linear\.app\/x\/issue\/MIK-9\)/)
  assert.match(prompt, /one short paragraph per item/)
  assert.match(prompt, /secretary/)
  assert.match(prompt, /Do not act until they say so/)
  assert.doesNotMatch(prompt, /The person's name/)
  assert.match(eventPrompt({ ...briefingEvent({ userId: 'u1', localDate: '2026-10-27', kind: 'daily', total: 1, counts: {} }, [], 'Alex Jiang'), tier }), /The person's name: Alex Jiang\./)
  assert.deepEqual((event.payload.items as { suggestionId: string }[]).map(item => item.suggestionId), ['s1', 's2'])
  // The chat shows the event as a dated label and the reply as one message per item.
  const items = chatItems([
    { id: 'm1', position: 1, createdAt: new Date(0), message: { role: 'user', content: prompt } },
    { id: 'm2', position: 2, createdAt: new Date(0), message: { role: 'assistant', content: 'Kevin 来信……要我起草回复吗？\n\nPR #212 的类型检查没过。要我开个线程修好吗？' } },
    { id: 'm3', position: 3, createdAt: new Date(0), message: { role: 'user', content: 'ok\n\nthanks' } },
  ])
  assert.deepEqual(items.map(item => [item.from, item.briefingDate ?? null, item.part ?? null, item.text]), [
    ['event', '2026-10-27', null, ''],
    ['coordinator', null, 0, 'Kevin 来信……要我起草回复吗？'],
    ['coordinator', null, 1, 'PR #212 的类型检查没过。要我开个线程修好吗？'],
    ['person', null, null, 'ok\n\nthanks'],
  ])
})
