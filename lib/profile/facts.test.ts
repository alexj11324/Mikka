import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { profileEnabled, researchEnabled } from './flags'
import type { DecisionAnswer, DecisionQuestion } from '@/lib/coordinator/decision'
import { CONSOLIDATION_QUESTIONS_PER_CALL, consolidationInput, consolidationCandidates, extractionPrompt, factInput, FIRST_SIGHT_MAX, mergedEvidence, mergedValue, parseFacts, planConsolidation, purchaseMerchant, raisedConfidence, subjectKey, type ConsolidationDecider, type StoredFact } from './facts'

const mail = (fields: Partial<ExternalNotification> = {}): ExternalNotification => ({ userId: 'u', source: 'gmail', externalId: 'm1', matterKey: 'gmail:t1', action: 'read', title: 'Your Weee! order has been delivered', url: null, actor: 'Weee! <orders@sayweee.com>', occurredAt: new Date('2026-10-20T19:05:00Z'), required: false, direct: false, fromSelf: false, automated: true, excerpt: 'Pixian bean paste x2, Sichuan peppercorn. Total $23.47', ...fields })

test('subjects fold to one key', () => {
  assert.equal(subjectKey('  Verizon  Plan. '), 'verizon plan')
  assert.equal(subjectKey('ＣＬＯＵＤＦＬＡＲＥ'), 'cloudflare')
  assert.equal(subjectKey('「川菜」'), '川菜')
  assert.equal(subjectKey('...'), '')
})

test('purchase and receipt mail is flagged for the model with its merchant', () => {
  assert.equal(purchaseMerchant(mail()), 'Weee')
  assert.equal(purchaseMerchant(mail({ actor: 'DoorDash <no-reply@doordash.com>', title: 'Order confirmation' })), 'DoorDash')
  assert.equal(purchaseMerchant(mail({ actor: 'Shop <a@b.com>', title: 'Your receipt from Blue Bottle' })), '')
  assert.equal(purchaseMerchant(mail({ actor: 'Dana <dana@acme.com>', title: 'Thursday agenda' })), null)
  assert.equal(purchaseMerchant(mail({ source: 'slack' })), null)
  const { instructions, prompt } = extractionPrompt(mail())
  assert.match(instructions, /purchase = \{merchant, items/)
  assert.equal(JSON.parse(prompt).receiptFrom, 'Weee')
})

test('the model answer is validated and capped at three facts', () => {
  const answer = `Sure: {"facts": [
    {"kind": "interest", "subject": "川菜调料", "confidence": 0.9, "topic": "川菜", "purchase": {"merchant": "Weee", "items": ["郫县豆瓣酱", "花椒"], "amount": 23.47, "currency": "USD", "date": "2026-10-20T19:00:00Z"}},
    {"kind": "pet", "subject": "dog", "confidence": 0.5},
    {"kind": "tool", "subject": "", "confidence": 0.5},
    {"kind": "subscription", "subject": "Verizon plan ending 0001", "confidence": 0.8, "slot": "Not A Slot", "expiresAt": "2026-11-01"},
    {"kind": "place", "subject": "Shadyside", "confidence": 0.4, "area": "Pittsburgh"},
    {"kind": "tool", "subject": "Cloudflare Tunnel", "confidence": 0.7}
  ]}`
  const facts = parseFacts(answer)
  assert.deepEqual(facts.map(fact => fact.subject), ['川菜调料', 'Verizon plan ending 0001', 'Shadyside'])
  assert.equal(facts[1].slot, undefined, 'a malformed slot is dropped, the fact kept')
  assert.deepEqual(parseFacts('no json'), [])
  assert.deepEqual(parseFacts('{"facts": "none"}'), [])
})

test('an extracted purchase keeps merchant, items, amount and date and only references its source', () => {
  const [fact] = parseFacts('{"facts": [{"kind": "interest", "subject": "川菜调料", "confidence": 0.9, "topic": "川菜", "purchase": {"merchant": "Weee", "items": ["郫县豆瓣酱"], "amount": 23.47, "currency": "USD", "date": null}}]}')
  const input = factInput(fact, mail(), 'suggestion-1')
  assert.equal(input.confidence, FIRST_SIGHT_MAX, 'one sighting is capped')
  assert.deepEqual(input.value, { topic: '川菜', purchases: [{ merchant: 'Weee', items: ['郫县豆瓣酱'], amount: 23.47, currency: 'USD', date: '2026-10-20T19:05:00.000Z' }] })
  assert.deepEqual(input.evidence, [{ source: 'gmail', suggestionId: 'suggestion-1', externalId: 'm1', at: '2026-10-20T19:05:00.000Z' }])
  assert.ok(!JSON.stringify(input).includes('bean paste'), 'no source text is stored')
})

test('repeats raise confidence and merge purchases and evidence without duplicates', () => {
  assert.ok(raisedConfidence(0.5, 0.6) > 0.6)
  assert.ok(raisedConfidence(0.94, 0.9) <= 0.95)
  const purchase = { merchant: 'Weee', items: [], amount: 10, currency: 'USD', date: '2026-10-01T00:00:00Z' }
  const merged = mergedValue({ topic: '川菜', purchases: [purchase] }, { purchases: [purchase, { ...purchase, date: '2026-10-08T00:00:00Z' }] })
  assert.equal((merged.purchases as unknown[]).length, 2)
  assert.equal(merged.topic, '川菜')
  const evidence = mergedEvidence([{ source: 'gmail', suggestionId: 'a', at: 'x' }], [{ source: 'gmail', suggestionId: 'a', at: 'x' }, { source: 'gmail', suggestionId: 'b', at: 'y' }])
  assert.deepEqual(evidence.map(item => item.suggestionId), ['a', 'b'])
})

const now = new Date('2026-10-28T09:30:00Z')
let next = 0
const fact = (fields: Partial<StoredFact>): StoredFact => ({ id: `f${++next}`, kind: 'interest', subject: 's', subjectKey: `s${next}`, value: {}, confidence: 0.6, lastSeenAt: new Date('2026-10-27T00:00:00Z'), expiresAt: null, state: 'active', userEdited: false, ...fields })
const order = (merchant: string, date: string) => ({ merchant, items: [], amount: 20, currency: 'USD', date })
const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)

/** A mocked Decision API: `choose` answers each question (undefined: leaves it unanswered). Records every call; no network. */
function mockDecider(choose: (question: Extract<DecisionQuestion, { type: 'choice' }>) => string | undefined) {
  const calls: { input: string; questions: DecisionQuestion[] }[] = []
  const decide: ConsolidationDecider = async (input, questions) => {
    calls.push({ input, questions })
    const answers = new Map<string, DecisionAnswer>()
    for (const question of questions) {
      if (question.type !== 'choice') continue
      const choice = choose(question)
      if (choice !== undefined) answers.set(question.name, { type: 'choice', name: question.name, choice })
    }
    return answers
  }
  return { decide, calls }
}
const choiceIn = (question: Extract<DecisionQuestion, { type: 'choice' }>, value: string) => question.choices.some(choice => choice.value === value)

const purchaseFacts = () => {
  const lunches = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map(day => order('DoorDash', `${day}T16:05:00Z`))
  return [
    fact({ subject: '川菜调料', subjectKey: '川菜调料', value: { topic: '川菜', purchases: [order('Weee', '2026-10-01T01:00:00Z'), order('Weee', '2026-10-08T01:00:00Z')] } }),
    fact({ subject: '花椒', subjectKey: '花椒', value: { topic: '川菜', purchases: [order('Instacart', '2026-10-15T01:00:00Z')] } }),
    fact({ subject: '午餐外卖', subjectKey: '午餐外卖', value: { purchases: lunches } }),
    fact({ kind: 'place', subject: 'Shadyside', subjectKey: 'shadyside', value: { area: 'Pittsburgh' } }),
    fact({ kind: 'place', subject: 'Squirrel Hill', subjectKey: 'squirrel hill', value: { area: 'Pittsburgh' } }),
  ]
}

test('the Decision API decides which grouped purchases become an interest, a routine or a place', async () => {
  const facts = purchaseFacts()
  const yes = mockDecider(question => question.instructions.includes('Weee') ? 'none' : ['interest', 'routine_weekdays', 'place'].find(value => choiceIn(question, value)))
  const { patterns, updates } = await planConsolidation(facts, { now, timeZone: 'America/New_York', locale: 'zh-CN' }, yes.decide)
  assert.deepEqual(updates, [])
  assert.equal(yes.calls.length, 1, 'one call per person')
  const bySubject = new Map(patterns.map(pattern => [`${pattern.kind}:${pattern.subject}`, pattern]))
  assert.equal(bySubject.get('interest:川菜')?.value.count, 3)
  assert.ok(bySubject.has('routine:DoorDash · 工作日 12:00 前后'), [...bySubject.keys()].join(', '))
  assert.ok(bySubject.has('place:Pittsburgh'))
  assert.equal(patterns.length, 3, 'Weee orders: the answer said none')
  assert.deepEqual(bySubject.get('interest:川菜')?.evidence[0].factIds, [facts[0].id, facts[1].id])
  const input = JSON.parse(yes.calls[0].input)
  assert.deepEqual(input.items.map((item: { name: string }) => item.name), yes.calls[0].questions.map(question => question.name))
  assert.ok(input.items.some((item: { merchant?: string; localOrderTimes?: string[] }) => item.merchant === 'DoorDash' && item.localOrderTimes?.every(time => time.endsWith('12:00'))))

  const english = await planConsolidation(facts, { now, timeZone: 'America/New_York', locale: 'en' }, mockDecider(question => question.instructions.includes('DoorDash') ? 'routine' : 'none').decide)
  assert.deepEqual(english.patterns.map(pattern => pattern.subject), ['DoorDash · around 12:00'], 'the answer, not a weekday share, sets the routine')

  const no = await planConsolidation(facts, { now, timeZone: 'America/New_York', locale: 'zh-CN' }, mockDecider(() => 'none').decide)
  assert.deepEqual(no.patterns, [], 'counts past the old thresholds make nothing without a yes')

  const two = [fact({ subject: '郫县豆瓣酱', subjectKey: '郫县豆瓣酱', value: { topic: '川菜' } }), fact({ subject: '花椒油', subjectKey: '花椒油', value: { topic: '川菜' } })]
  const few = await planConsolidation(two, { now, timeZone: 'UTC', locale: 'zh-CN' }, mockDecider(question => choiceIn(question, 'interest') ? 'interest' : undefined).decide)
  assert.deepEqual(few.patterns.map(pattern => pattern.subject), ['川菜'], 'two purchases are enough when the answer says so')
  const single = mockDecider(() => 'interest')
  assert.deepEqual(await planConsolidation([two[0]], { now, timeZone: 'UTC', locale: 'zh-CN' }, single.decide), { updates: [], patterns: [] })
  assert.equal(single.calls.length, 0, 'nothing to group, nothing to ask')
})

test('stale facts and slots follow the Decision API; passed dates and corrections stay code', async () => {
  const facts = [
    fact({ kind: 'subscription', expiresAt: new Date('2026-10-27T00:00:00Z'), lastSeenAt: old }),
    fact({ kind: 'deadline', expiresAt: new Date('2026-11-02T00:00:00Z') }),
    fact({ subject: 'lower me', lastSeenAt: old, confidence: 0.6 }),
    fact({ subject: 'keep me', lastSeenAt: old, confidence: 0.15 }),
    fact({ subject: 'expire me', lastSeenAt: old, confidence: 0.9 }),
    fact({ subject: 'corrected', lastSeenAt: old, confidence: 0.6, userEdited: true }),
    fact({ kind: 'place', subject: 'Pittsburgh', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
    fact({ kind: 'place', subject: 'Boston', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-10-20T00:00:00Z') }),
    fact({ kind: 'preference', subject: 'vegetarian', value: { slot: 'diet' }, userEdited: true, lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
    fact({ kind: 'preference', subject: 'omnivore', value: { slot: 'diet' }, lastSeenAt: new Date('2026-10-20T00:00:00Z') }),
  ]
  const answers: Record<string, string> = { 'lower me': 'lower', 'keep me': 'keep', 'expire me': 'expire' }
  // The mock answers each stale question by the fact it was built for.
  const { items } = consolidationCandidates(facts, { now, timeZone: 'UTC', locale: 'en' })
  const staleBySubject = new Map(items.filter(item => item.kind === 'stale').map(item => [item.kind === 'stale' ? item.fact.subject : '', item.question.name]))
  assert.deepEqual([...staleBySubject.keys()].sort(), ['expire me', 'keep me', 'lower me'], 'corrections and dated facts are never asked to fade')
  assert.equal(items.filter(item => item.kind === 'slot').length, 1, 'a slot with a correction is not asked')
  const byName = new Map([...staleBySubject].map(([subject, name]) => [name, answers[subject]]))
  const decided = mockDecider(question => byName.get(question.name) ?? question.choices.find(choice => choice.description?.startsWith('Pittsburgh'))?.value)
  const result = await planConsolidation(facts, { now, timeZone: 'UTC', locale: 'en' }, decided.decide)
  const updates = new Map(result.updates.map(change => [change.id, change]))
  assert.equal(updates.get(facts[0].id)?.state, 'expired', 'a passed renewal date voids the fact')
  assert.equal(updates.get(facts[0].id)?.unchangedSince, undefined)
  assert.equal(updates.has(facts[1].id), false)
  assert.ok(Math.abs((updates.get(facts[2].id)?.confidence ?? 0) - 0.57) < 1e-9)
  assert.equal(updates.get(facts[2].id)?.state, undefined)
  assert.equal(updates.get(facts[2].id)?.unchangedSince, facts[2].lastSeenAt)
  assert.equal(updates.has(facts[3].id), false, 'kept, though its confidence is below the old expiry line')
  assert.equal(updates.get(facts[4].id)?.state, 'expired', 'expired, though its confidence is high')
  assert.equal(updates.has(facts[5].id), false, 'a correction does not fade')
  assert.equal(updates.has(facts[6].id), false, 'the answer keeps the older Pittsburgh')
  assert.equal(updates.get(facts[7].id)?.state, 'expired', 'the newest answer loses when the Decision API says so')
  assert.equal(updates.has(facts[8].id), false, 'the correction wins its slot')
  assert.equal(updates.get(facts[9].id)?.state, 'expired')
  assert.equal(decided.calls.length, 1)
})

test('no answer changes nothing tonight for the items it covered', async () => {
  const facts = [
    ...purchaseFacts(),
    fact({ kind: 'deadline', expiresAt: new Date('2026-10-01T00:00:00Z') }),
    fact({ lastSeenAt: old, confidence: 0.1 }),
    fact({ kind: 'place', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
    fact({ kind: 'place', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-10-20T00:00:00Z') }),
  ]
  let calls = 0
  const unavailable: ConsolidationDecider = async () => { calls++; return null }
  const result = await planConsolidation(facts, { now, timeZone: 'UTC', locale: 'en' }, unavailable)
  assert.equal(calls, 1)
  assert.deepEqual(result.patterns, [])
  assert.deepEqual(result.updates, [{ id: facts[5].id, state: 'expired' }], 'only the passed deadline, a code rule')
  const malformed = await planConsolidation(facts, { now, timeZone: 'UTC', locale: 'en' }, mockDecider(() => 'not-a-choice').decide)
  assert.deepEqual(malformed, result, 'an answer outside the choices is no answer')
})

test('questions go in batches of 40, at most three calls a night; the rest wait', async () => {
  const facts = Array.from({ length: 130 }, (_, index) => fact({ subject: `old ${index}`, lastSeenAt: old }))
  const mock = mockDecider(() => 'expire')
  const result = await planConsolidation(facts, { now, timeZone: 'UTC', locale: 'en' }, mock.decide)
  assert.deepEqual(mock.calls.map(call => call.questions.length), [CONSOLIDATION_QUESTIONS_PER_CALL, CONSOLIDATION_QUESTIONS_PER_CALL, CONSOLIDATION_QUESTIONS_PER_CALL])
  const names = mock.calls.flatMap(call => call.questions.map(question => question.name))
  assert.equal(new Set(names).size, names.length, 'question names are distinct')
  assert.equal(result.updates.length, 120)
  assert.ok(JSON.parse(consolidationInput([], now)).items.length === 0)
})

test('proactive deployment switches are off unless set to 1 or true', t => {
  const saved = { profile: process.env.PROACTIVE_PROFILE_ENABLED, research: process.env.PROACTIVE_RESEARCH_ENABLED }
  t.after(() => {
    for (const [name, value] of [['PROACTIVE_PROFILE_ENABLED', saved.profile], ['PROACTIVE_RESEARCH_ENABLED', saved.research]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  delete process.env.PROACTIVE_PROFILE_ENABLED
  delete process.env.PROACTIVE_RESEARCH_ENABLED
  assert.equal(profileEnabled(), false)
  assert.equal(researchEnabled(), false)
  for (const value of ['0', 'false', 'yes', '']) {
    process.env.PROACTIVE_PROFILE_ENABLED = value
    assert.equal(profileEnabled(), false, value)
  }
  for (const value of ['1', 'true', 'TRUE']) {
    process.env.PROACTIVE_PROFILE_ENABLED = value
    assert.equal(profileEnabled(), true, value)
  }
  assert.equal(researchEnabled(), false, 'the two switches are separate')
})
