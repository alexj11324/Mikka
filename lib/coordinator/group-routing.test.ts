import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addsNothing, correctionFrom, followUpInstructions, mentionRoute, NOTHING_TO_ADD, routingInput, UnknownMentionError } from './group-routing'

const members = [
  { id: 'lead', name: 'Tech Lead', description: 'Plans and reviews architecture' },
  { id: 'ui', name: 'UI Designer', description: 'Layouts, visuals, interaction' },
  { id: 'infra', name: 'Backend & Infra', description: 'Databases, deploys, CI' },
]

test('an @mention goes straight to that agent, in mention order', () => {
  assert.deepEqual(mentionRoute({ text: 'hi', mentions: ['ui', 'infra', 'ui'] }, members), { by: 'mention', responders: ['ui', 'infra'] })
  assert.equal(mentionRoute({ text: 'hi', mentions: [] }, members), null)
})

test('mentioning a non-member is an error', () => {
  assert.throws(() => mentionRoute({ text: 'hi', mentions: ['ghost'] }, members), UnknownMentionError)
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
