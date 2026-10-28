import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExternalNotification } from '@/lib/suggestions/notification'
import { profileEnabled, researchEnabled } from './flags'
import { extractionPrompt, factInput, FIRST_SIGHT_MAX, mergedEvidence, mergedValue, parseFacts, planConsolidation, purchaseMerchant, raisedConfidence, subjectKey, type StoredFact } from './facts'

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

test('the nightly merge turns scattered purchases into an interest and a routine', () => {
  const lunches = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map(day => order('DoorDash', `${day}T16:05:00Z`))
  const facts = [
    fact({ subject: '川菜调料', subjectKey: '川菜调料', value: { topic: '川菜', purchases: [order('Weee', '2026-10-01T01:00:00Z'), order('Weee', '2026-10-08T01:00:00Z')] } }),
    fact({ subject: '花椒', subjectKey: '花椒', value: { topic: '川菜', purchases: [order('Instacart', '2026-10-15T01:00:00Z')] } }),
    fact({ subject: '午餐外卖', subjectKey: '午餐外卖', value: { purchases: lunches } }),
    fact({ kind: 'place', subject: 'Shadyside', subjectKey: 'shadyside', value: { area: 'Pittsburgh' } }),
    fact({ kind: 'place', subject: 'Squirrel Hill', subjectKey: 'squirrel hill', value: { area: 'Pittsburgh' } }),
  ]
  const { patterns, updates } = planConsolidation(facts, { now, timeZone: 'America/New_York', locale: 'zh-CN' })
  assert.deepEqual(updates, [])
  const bySubject = new Map(patterns.map(pattern => [`${pattern.kind}:${pattern.subject}`, pattern]))
  assert.equal(bySubject.get('interest:川菜')?.value.count, 3)
  assert.ok(bySubject.has('routine:DoorDash · 工作日 12:00 前后'), [...bySubject.keys()].join(', '))
  assert.ok(bySubject.has('place:Pittsburgh'))
  assert.deepEqual(bySubject.get('interest:川菜')?.evidence[0].factIds, [facts[0].id, facts[1].id])
  const english = planConsolidation(facts, { now, timeZone: 'America/New_York', locale: 'en' })
  assert.ok(english.patterns.some(pattern => pattern.subject === 'DoorDash · weekdays around 12:00'))
})

test('the nightly merge expires dated facts, fades stale ones and keeps the newest answer per slot', () => {
  const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
  const facts = [
    fact({ kind: 'subscription', expiresAt: new Date('2026-10-27T00:00:00Z') }),
    fact({ kind: 'deadline', expiresAt: new Date('2026-11-02T00:00:00Z') }),
    fact({ lastSeenAt: old, confidence: 0.6 }),
    fact({ lastSeenAt: old, confidence: 0.2 }),
    fact({ lastSeenAt: old, confidence: 0.6, userEdited: true }),
    fact({ kind: 'place', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
    fact({ kind: 'place', value: { slot: 'home_city' }, lastSeenAt: new Date('2026-10-20T00:00:00Z') }),
    fact({ kind: 'preference', value: { slot: 'diet' }, userEdited: true, lastSeenAt: new Date('2026-09-01T00:00:00Z') }),
    fact({ kind: 'preference', value: { slot: 'diet' }, lastSeenAt: new Date('2026-10-20T00:00:00Z') }),
  ]
  const updates = new Map(planConsolidation(facts, { now, timeZone: 'UTC', locale: 'en' }).updates.map(change => [change.id, change]))
  assert.equal(updates.get(facts[0].id)?.state, 'expired')
  assert.equal(updates.has(facts[1].id), false)
  assert.ok(Math.abs((updates.get(facts[2].id)?.confidence ?? 0) - 0.57) < 1e-9)
  assert.equal(updates.get(facts[2].id)?.state, undefined)
  assert.equal(updates.get(facts[3].id)?.state, 'expired')
  assert.equal(updates.has(facts[4].id), false, 'a correction does not fade')
  assert.equal(updates.get(facts[5].id)?.state, 'expired')
  assert.equal(updates.has(facts[6].id), false)
  assert.equal(updates.has(facts[7].id), false, 'the correction wins its slot')
  assert.equal(updates.get(facts[8].id)?.state, 'expired')
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
