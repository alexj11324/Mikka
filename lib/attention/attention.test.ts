import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionAnswer } from '@/lib/coordinator/decision'
import { chatItems } from '@/lib/coordinator/context'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { BUDGET_WINDOW_MS, budgetState } from './budget'
import { handoffPrompt, HANDOFF_PREFIX, mergeEvidence, QUIET_REPLY, stateAfterNotice, type HandoffPayload, type Notice } from './handoff'
import { attentionQuestions, attentionState, codeLevel, continuedLevel, fallbackLevel, readJudgment, ruleLevel, withFloor, type Assessment } from './judgment'

const none: Assessment = { cost: false, due: 'unknown', reversible: true, verificationCode: false }
const cost = (fields: Partial<Assessment> = {}): Assessment => ({ ...none, cost: true, ...fields })

test('code floors the level under any cost', () => {
  assert.equal(withFloor('low', cost()), 'high')
  assert.equal(withFloor('normal', cost({ due: 'later' })), 'high')
  assert.equal(withFloor('high', cost({ due: 'within48h' })), 'critical')
  assert.equal(withFloor('normal', cost({ due: 'within7d', reversible: false })), 'critical')
  assert.equal(withFloor('normal', cost({ due: 'within7d' })), 'high')
  assert.equal(withFloor('critical', cost({ due: 'later' })), 'critical')
  // No cost: the model's level stands. Ask and unclear keep their answer.
  assert.equal(withFloor('normal', none), 'normal')
  assert.equal(withFloor('ask', cost({ due: 'within48h' })), 'ask')
  assert.equal(withFloor('unclear', cost()), 'unclear')
})

test('a fresh verification code is critical, an old one is not shown', () => {
  const code = { ...none, verificationCode: true }
  assert.equal(codeLevel('normal', code, 3 * 60_000), 'critical')
  assert.equal(codeLevel('critical', code, 11 * 60_000), 'low')
  assert.equal(codeLevel('normal', none, 0), 'normal')
})

test('a later notice on an unanswered matter never rates below it', () => {
  assert.equal(continuedLevel('normal', { level: 'high', state: 'quiet' }), 'high')
  assert.equal(continuedLevel('critical', { level: 'high', state: 'notified' }), 'critical')
  assert.equal(continuedLevel('normal', { level: 'high', state: 'handled' }), 'normal')
  assert.equal(continuedLevel('low', null), 'low')
})

const notification = (fields: Partial<ExternalNotification> = {}): ExternalNotification => ({ userId: 'u', source: 'gmail', externalId: 'x', matterKey: 'gmail:t', action: 'reply', title: 't', url: null, actor: null, occurredAt: new Date('2026-10-27T08:00:00Z'), required: false, direct: false, fromSelf: false, automated: false, excerpt: '', ...fields })

test('fixed rules: own actions and automated mail not addressed to the person are low', () => {
  assert.equal(ruleLevel(notification({ fromSelf: true, required: true })), 'low')
  assert.equal(ruleLevel(notification({ automated: true })), 'low')
  // An automated notice addressed to the person, such as an account warning, goes to the model.
  assert.equal(ruleLevel(notification({ automated: true, direct: true })), null)
  assert.equal(ruleLevel(notification({ direct: true })), null)
  // Without the model nothing is routed; what was addressed to the person stays in 建议.
  assert.equal(fallbackLevel(notification({ direct: true })), 'normal')
  assert.equal(fallbackLevel(notification({ required: true })), 'normal')
  assert.equal(fallbackLevel(notification()), 'low')
})

type Answer = Exclude<DecisionAnswer, { type: 'refusal' }>
const answers = (list: Answer[]) => new Map(list.map(answer => [answer.name, answer]))

test('the judgment reads cost, due and reversibility before the level', () => {
  const judged = readJudgment(answers([
    { type: 'predicate', name: 'cost', probability: 0.9 },
    { type: 'choice', name: 'due', choice: 'within7d' },
    { type: 'predicate', name: 'irreversible', probability: 0.8 },
    { type: 'predicate', name: 'verificationCode', probability: 0.1 },
    { type: 'choice', name: 'level', choice: 'normal' },
    { type: 'choice', name: 'continues', choice: 'm2' },
  ]), 60_000, ['m1', 'm2'])!
  assert.equal(judged.level, 'critical')
  assert.deepEqual(judged.assessment, { cost: true, due: 'within7d', reversible: false, verificationCode: false })
  assert.equal(judged.continues, 'm2')
  // No cost: due and reversibility do not count, and an unknown matter id is ignored.
  const quiet = readJudgment(answers([
    { type: 'predicate', name: 'cost', probability: 0.2 },
    { type: 'choice', name: 'due', choice: 'within48h' },
    { type: 'predicate', name: 'irreversible', probability: 0.9 },
    { type: 'choice', name: 'level', choice: 'normal' },
    { type: 'choice', name: 'continues', choice: 'm9' },
  ]), 0, ['m1'])!
  assert.equal(quiet.level, 'normal')
  assert.deepEqual(quiet.assessment, none)
  assert.equal(quiet.continues, null)
  assert.equal(readJudgment(answers([{ type: 'choice', name: 'level', choice: 'unclear' }]), 0, [])!.level, 'unclear')
  assert.equal(readJudgment(answers([{ type: 'predicate', name: 'cost', probability: 1 }]), 0, []), null)
})

test('the continues question is asked only with earlier matters, and the state carries the time', () => {
  assert.equal(attentionQuestions([]).some(question => question.name === 'continues'), false)
  const matters = [{ id: 'm1', title: 'Renew domain', level: 'high' as const, state: 'quiet', reason: 'not due yet' }]
  const continues = attentionQuestions(matters).find(question => question.name === 'continues')
  assert.deepEqual(continues?.type === 'choice' && continues.choices.map(choice => choice.value), ['m1', 'none'])
  const state = attentionState(notification({ excerpt: 'Your code is 123456', direct: true }), new Date('2026-10-27T08:04:00Z'), matters, null)
  assert.equal(state.minutesAgo, '4')
  assert.equal(state.content, 'Your code is 123456')
  assert.equal(state.relationship, 'addressed to the person')
  assert.match(state.earlierMatters, /m1: "Renew domain", level high, quiet \(not due yet\)/)
})

test('budgets: 5 notifications a day, 30 minutes apart; critical skips the spacing, not the cap', () => {
  const now = new Date('2026-10-27T12:00:00Z')
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
  assert.deepEqual(budgetState('notify', [], now), { open: true, remaining: 5 })
  assert.deepEqual(budgetState('notify', [ago(10)], now), { open: false, nextAt: ago(-20) })
  assert.deepEqual(budgetState('notify', [ago(10)], now, 'critical'), { open: true, remaining: 4 })
  const five = [ago(10), ago(100), ago(200), ago(300), ago(400)]
  assert.deepEqual(budgetState('notify', five, now, 'critical'), { open: false, nextAt: new Date(ago(400).getTime() + BUDGET_WINDOW_MS) })
  // Spends older than a day do not count.
  assert.deepEqual(budgetState('notify', [new Date(now.getTime() - BUDGET_WINDOW_MS - 1)], now), { open: true, remaining: 5 })
  const twelve = Array.from({ length: 12 }, (_, index) => ago(index))
  assert.equal(budgetState('handoff', twelve, now).open, false)
  assert.deepEqual(budgetState('handoff', twelve.slice(1), now), { open: true, remaining: 1 })
})

test('repeated notices join their matter; only a raised level hands it over again', () => {
  assert.equal(stateAfterNotice({ state: 'handed', level: 'high' }, 'critical', true), null)
  assert.equal(stateAfterNotice({ state: 'waiting', level: 'high' }, 'high', true), null)
  assert.equal(stateAfterNotice({ state: 'quiet', level: 'high' }, 'high', true), null)
  assert.equal(stateAfterNotice({ state: 'quiet', level: 'high' }, 'critical', true), 'waiting')
  assert.equal(stateAfterNotice({ state: 'snoozed', level: 'ask' }, 'high', true), 'waiting')
  assert.equal(stateAfterNotice({ state: 'handled', level: 'high' }, 'high', true), 'waiting')
  assert.equal(stateAfterNotice({ state: 'handled', level: 'high' }, 'normal', false), null)
  const first: Notice = { source: 'github', title: 'CI failed', actor: null, occurredAt: '2026-10-27T08:00:00.000Z', url: null, excerpt: 'x'.repeat(1000) }
  const merged = mergeEvidence(mergeEvidence(null, first, 'github:a/b#1'), { ...first, title: 'CI failed again' }, 'github:a/b#1')
  assert.equal(merged.latest.title, 'CI failed again')
  assert.equal(merged.earlier[0].excerpt.length, 300)
  assert.deepEqual(merged.keys, ['github:a/b#1'])
  assert.deepEqual(mergeEvidence(merged, first, 'gmail:t9').keys, ['github:a/b#1', 'gmail:t9'])
})

const payload = (fields: Partial<HandoffPayload> = {}): HandoffPayload => ({
  matterId: 'mat-1', kind: 'item', level: 'critical', title: 'Domain expires tomorrow', url: 'https://mail.google.com/x',
  assessment: cost({ due: 'within48h', reversible: false }),
  evidence: { latest: { source: 'gmail', title: 'Domain expires tomorrow', actor: 'registrar', occurredAt: '2026-10-27T08:00:00.000Z', url: 'https://mail.google.com/x', excerpt: 'Renew now or lose it.' }, earlier: [], keys: ['gmail:t'] },
  minutesAgo: 2, recheck: false, personAsked: false, previous: null, notifyBudget: { open: true, remaining: 5 }, ...fields,
})

test('the handoff prompt is hidden evidence with the assessment and the budget', () => {
  const text = handoffPrompt(payload())
  assert.ok(text.startsWith(HANDOFF_PREFIX))
  assert.match(text, /Matter mat-1/)
  assert.match(text, /lands within 48 hours; it cannot be undone/)
  assert.match(text, /untrusted evidence/)
  assert.match(text, /Notification budget: open, 5 left/)
  assert.match(handoffPrompt(payload({ notifyBudget: { open: false, nextAt: '2026-10-27T13:00:00.000Z' } })), /snooze .* runAt 2026-10-27T13:00:00.000Z/)
  assert.match(handoffPrompt(payload({ assessment: { ...none, verificationCode: true } })), /verification code, 2 minute/)
  const briefing = handoffPrompt(payload({ kind: 'briefing', evidence: { localDate: '2026-10-27', total: 4, items: [{ title: 'Review PR', source: 'github', level: 'high', url: null, actor: 'dana' }] } }))
  assert.match(briefing, /08:00 briefing \(2026-10-27\)/)
  assert.match(briefing, /1\. \[high\] github: Review PR \(from dana\)/)
})

test('the chat hides handoffs, quiet replies and the decision tool', () => {
  const at = new Date('2026-10-27T08:00:00Z')
  const rows = [
    { position: 1, createdAt: at, message: { role: 'user' as const, content: 'hi' } },
    { position: 2, createdAt: at, message: { role: 'assistant' as const, content: 'Hello!' } },
    { position: 3, createdAt: at, message: { role: 'user' as const, content: handoffPrompt(payload()) } },
    { position: 4, createdAt: at, message: { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'record_attention', input: {} }] } },
    { position: 5, createdAt: at, message: { role: 'assistant' as const, content: 'Your domain expires tomorrow and cannot be recovered after. Want me to open the renewal page?' } },
    { position: 6, createdAt: at, message: { role: 'user' as const, content: handoffPrompt(payload({ matterId: 'mat-2' })) } },
    { position: 7, createdAt: at, message: { role: 'assistant' as const, content: QUIET_REPLY } },
  ]
  const items = chatItems(rows)
  assert.deepEqual(items.map(item => [item.from, item.text]), [
    ['person', 'hi'],
    ['coordinator', 'Hello!'],
    ['coordinator', 'Your domain expires tomorrow and cannot be recovered after. Want me to open the renewal page?'],
  ])
  assert.deepEqual(items[2].tools, [])
})
