import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionAnswer } from './decision'
import { addsNothing, correctionFrom, followUpInstructions, mentionRoute, NOTHING_TO_ADD, routeFromAnswers, routingInput, routingQuestions, UnknownMentionError } from './group-routing'

const members = [
  { id: 'lead', name: 'Tech Lead', description: 'Plans and reviews architecture' },
  { id: 'ui', name: 'UI Designer', description: 'Layouts, visuals, interaction' },
  { id: 'infra', name: 'Backend & Infra', description: 'Databases, deploys, CI' },
]
const choice = (pick: string, confidence: number, probabilities: [string, number][] = []) =>
  ({ type: 'choice' as const, name: 'responder', choice: pick, confidence, probabilities: probabilities.map(([value, probability]) => ({ value, probability })) })
const answers = (...entries: Exclude<DecisionAnswer, { type: 'refusal' }>[]) => new Map(entries.map(entry => [entry.name, entry]))

test('an @mention goes straight to that agent, in mention order', () => {
  assert.deepEqual(mentionRoute({ text: 'hi', mentions: ['ui', 'infra', 'ui'] }, members), { by: 'mention', responders: ['ui', 'infra'] })
  assert.equal(mentionRoute({ text: 'hi', mentions: [] }, members), null)
})

test('mentioning a non-member is an error', () => {
  assert.throws(() => mentionRoute({ text: 'hi', mentions: ['ghost'] }, members), UnknownMentionError)
})

test('a confident pick answers alone', () => {
  assert.deepEqual(routeFromAnswers(answers(choice('ui', 0.8)), members, 'lead'), { by: 'model', responders: ['ui'], confidence: 0.8 })
})

test('an unsure pick goes to the Lead, who asks whether that member was meant', () => {
  assert.deepEqual(routeFromAnswers(answers(choice('infra', 0.4)), members, 'lead'), { by: 'lead', responders: ['lead'], ask: 'infra' })
  assert.deepEqual(routeFromAnswers(answers(choice('lead', 0.4)), members, 'lead'), { by: 'lead', responders: ['lead'] })
})

test('no answer, or a pick outside the group, goes to the Lead', () => {
  assert.deepEqual(routeFromAnswers(null, members, 'lead'), { by: 'lead', responders: ['lead'] })
  assert.deepEqual(routeFromAnswers(answers(choice('ghost', 0.99)), members, 'lead'), { by: 'lead', responders: ['lead'] })
})

test('a question for everyone runs every member in turn, the most relevant first', () => {
  const route = routeFromAnswers(answers(choice('ui', 0.5, [['lead', 0.3], ['ui', 0.5], ['infra', 0.2]]), { type: 'predicate', name: 'wantsEveryone', probability: 0.9 }), members, 'lead')
  assert.deepEqual(route, { by: 'model', responders: ['ui', 'lead', 'infra'], confidence: 0.5 })
})

test('the model picks among members by role description', () => {
  const [responder, everyone] = routingQuestions(members)
  assert.equal(responder.type, 'choice')
  assert.deepEqual(responder.type === 'choice' && responder.choices.map(entry => entry.value), ['lead', 'ui', 'infra'])
  assert.match(responder.type === 'choice' ? responder.choices[1].description ?? '' : '', /UI Designer: Layouts/)
  assert.equal(everyone.name, 'wantsEveryone')
})

test('the model reads context and past corrections before the message', () => {
  const input = routingInput(
    { text: 'Why is the deploy red?', mentions: [], recent: [{ author: 'Alex', text: 'shipping today' }] },
    members,
    [{ message: 'CI broke', wrongId: 'ui', rightId: 'infra' }, { message: 'x', wrongId: 'gone' }],
  )
  assert.match(input, /context only[\s\S]*Alex: shipping today/)
  assert.match(input, /"CI broke" was not for UI Designer; it was for Backend & Infra/)
  assert.doesNotMatch(input, /"x"/)
  assert.ok(input.endsWith('New message:\nWhy is the deploy red?'))
})

test('later members add only what is new, or stay silent', () => {
  assert.equal(followUpInstructions([]), '')
  assert.match(followUpInstructions([{ author: 'UI Designer', text: 'Use a sheet' }]), /UI Designer: Use a sheet[\s\S]*nothing to add/)
  assert.ok(addsNothing(` ${NOTHING_TO_ADD}\n`))
  assert.ok(!addsNothing('One more thing'))
})

test('re-@ing someone else or saying "不是你" records a correction', () => {
  const routed = { message: 'Fix the button color', responderId: 'infra', by: 'model' as const }
  assert.deepEqual(correctionFrom(routed, { text: '@UI 你来', mentions: ['ui'] }), { message: 'Fix the button color', wrongId: 'infra', rightId: 'ui' })
  assert.deepEqual(correctionFrom(routed, { text: '不是你', mentions: [] }), { message: 'Fix the button color', wrongId: 'infra' })
  assert.equal(correctionFrom(routed, { text: 'thanks', mentions: [] }), null)
  assert.equal(correctionFrom({ ...routed, by: 'mention' }, { text: '不是你', mentions: [] }), null)
})
