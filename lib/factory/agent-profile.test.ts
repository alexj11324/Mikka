import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AgentProfileError, agentProfileDigest, agentProfileInstructions, parseAgentProfile } from './agent-profile-definition'
import { agentProfileSkillsCatalog, resolveAgentProfileSkills } from './agent-profile-skills'
import { profileDecisionQuestions, selectedProfileAnswer } from './agent-profile-decision'
import type { DecisionAnswer } from '@/lib/coordinator/decision'
import { createAgentProfileHandler } from './agent-profile-http'

const profile = () => parseAgentProfile({ name: 'Backend', harness: 'codex', model: { mode: 'inherit' }, skills: ['systematic-debugging'], instructions: 'Private project guidance.' })

test('strict Profile input only permits references and additive instructions', () => {
  assert.equal(profile().enabled, true)
  for (const extra of [{ token: 'secret' }, { tools: ['shell'] }, { ownerId: 'someone-else' }, { hook: 'curl private' }]) assert.throws(() => parseAgentProfile({ ...profile(), ...extra }))
  assert.throws(() => parseAgentProfile({ ...profile(), skills: ['../../secrets'] }))
  assert.throws(() => parseAgentProfile({ ...profile(), skills: ['systematic-debugging', 'systematic-debugging'] }))
  assert.throws(() => parseAgentProfile({ ...profile(), harness: 'codex', model: { mode: 'fixed', harness: 'claude_code', model: 'model', source: { kind: 'subscription', connectionId: randomUUID() } } }))
  assert.throws(() => parseAgentProfile({ ...profile(), model: { mode: 'fixed', harness: 'codex', model: 'model', source: { kind: 'subscription', connectionId: randomUUID(), token: 'secret' } } }))
  assert.throws(() => parseAgentProfile({ ...profile(), instructions: 'x'.repeat(40_000) }), { code: 'agentProfileTooLarge' })
})

test('controlled Skills freeze actual content and version with the canonical digest', () => {
  const definition = profile(), skills = resolveAgentProfileSkills(definition.skills)
  const hash = agentProfileDigest(definition, skills)
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(agentProfileDigest(parseAgentProfile(JSON.parse(JSON.stringify(definition))), skills), hash)
  assert.notEqual(agentProfileDigest({ ...definition, instructions: 'A revised rule.' }, skills), hash)
  assert.notEqual(agentProfileDigest(definition, skills.map(skill => ({ ...skill, version: 2 }))), hash)
  const instructions = agentProfileInstructions(definition, skills)
  assert.ok(instructions.includes(definition.instructions)); assert.ok(instructions.includes(skills[0].content))
  assert.ok(instructions.includes(skills[0].digest))
  assert.throws(() => resolveAgentProfileSkills(['unreviewed-skill']), { code: 'agentProfileSkillUnavailable' })
  assert.ok(agentProfileSkillsCatalog().every(skill => !('content' in skill)))
})

const catalog = [
  { id: randomUUID(), name: 'Interface', description: 'Implement interface work.', roles: ['implementation', 'ui'], harness: 'claude_code' as const, model: 'haiku-fixture' },
  { id: randomUUID(), name: 'Backend', description: 'Repair server behavior.', roles: ['implementation', 'backend'], harness: 'codex' as const, model: 'luna-fixture' },
  { id: randomUUID(), name: 'Review', description: 'Independently inspect the candidate.', roles: ['review'], harness: 'codex' as const, model: 'luna-fixture' },
]
const answer = (id: string, confidence = .9, why = 'capability_fit') => new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
  ['profile', { type: 'choice', name: 'profile', choice: id, confidence }], ['reason', { type: 'choice', name: 'reason', choice: why }],
])
for (const row of catalog) test(`Decision exact-ID selection: ${row.name}`, () => {
  assert.equal(selectedProfileAnswer(catalog, answer(row.id))?.id, row.id)
  assert.equal(selectedProfileAnswer(catalog, answer(row.id))?.reason, 'capability_fit', 'the reason is stored as a code, worded by the reader\'s language')
  const questions = profileDecisionQuestions(catalog)
  assert.equal(questions[0].type, 'choice')
  assert.ok(JSON.stringify(questions).includes(row.id))
})
test('Decision refusals, stale/unknown IDs, names, low confidence and absent reasons cannot select a Profile', () => {
  for (const id of ['none', 'Backend', randomUUID(), '']) assert.equal(selectedProfileAnswer(catalog, answer(id)), null)
  assert.equal(selectedProfileAnswer(catalog, answer(catalog[0].id, .54)), null)
  assert.equal(selectedProfileAnswer(catalog, answer(catalog[0].id, Number.NaN)), null)
  assert.equal(selectedProfileAnswer(catalog, answer(catalog[0].id, .99, 'uncertain')), null)
  assert.equal(selectedProfileAnswer(catalog, null), null)
  assert.equal(selectedProfileAnswer(catalog, new Map([['profile', { type: 'choice', name: 'profile', choice: catalog[0].id }]])), null)
  const question = profileDecisionQuestions(catalog)[0]
  assert.equal(question.type, 'choice')
  const payload = JSON.stringify(question.type === 'choice' ? question.choices.map(choice => choice.description) : [])
  for (const forbidden of ['instructions', 'connectionId', 'keyId', 'ownerId', 'content']) assert.ok(!payload.includes(`"${forbidden}"`))
})

test('Profile HTTP guards owner scope, same origin, strict bodies, and optimistic version errors', async () => {
  const workspaceId = randomUUID(), id = randomUUID(), calls: string[] = []
  const stored = { ...profile(), id, version: 1, digest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null }
  const handler = createAgentProfileHandler({
    authenticate: async () => ({ ownerId: 'authenticated-owner', workspaceId }),
    management: async scope => { assert.equal(scope.ownerId, 'authenticated-owner'); calls.push('list'); return { profiles: [stored] } },
    store: {
      get: async () => stored, history: async () => [],
      create: async scope => { assert.equal(scope.ownerId, 'authenticated-owner'); calls.push('create'); return stored },
      update: async () => { calls.push('update'); throw new AgentProfileError('agentProfileVersionConflict') }, archive: async () => stored,
    },
  })
  const url = `https://mikka.example/api/factory/agent-profiles?workspaceId=${workspaceId}`
  const get = await handler(new Request(url)); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'private, no-store')
  const make = (body: unknown, origin = 'https://mikka.example') => new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await handler(make({ profile: profile() }, 'https://evil.example'))).status, 403)
  assert.equal((await handler(make({ profile: profile(), ownerId: 'forged' }))).status, 400)
  assert.equal((await handler(make({ profile: profile(), workspaceId: randomUUID() }))).status, 404)
  assert.equal((await handler(make({ profile: profile() }))).status, 201)
  const stale = await handler(new Request(url, { method: 'PATCH', headers: { origin: 'https://mikka.example', 'content-type': 'application/json' }, body: JSON.stringify({ profile: profile(), version: 1 }) }), id)
  assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: 'agentProfileVersionConflict' })
  assert.deepEqual(calls, ['list', 'create', 'update'])
})


test('Profile availability preview accepts only an explicit allowed location and UUID device', async () => {
  const workspaceId = randomUUID(), deviceId = randomUUID(), previews: unknown[] = []
  const handler = createAgentProfileHandler({ authenticate: async () => ({ ownerId: 'owner' }), management: async (_scope, preview) => { previews.push(preview); return { profiles: [] } },
    store: { get: async () => { throw new Error('unused') }, history: async () => [], create: async () => { throw new Error('unused') }, update: async () => { throw new Error('unused') }, archive: async () => { throw new Error('unused') } } })
  const url = `https://mikka.example/api/factory/agent-profiles?workspaceId=${workspaceId}`
  assert.equal((await handler(new Request(`${url}&location=local&deviceId=${deviceId}`))).status, 200)
  assert.deepEqual(previews, [{ location: 'local', deviceId }])
  assert.equal((await handler(new Request(`${url}&location=unknown`))).status, 400)
  assert.equal((await handler(new Request(`${url}&deviceId=foreign-text`))).status, 400)
  assert.equal(previews.length, 1)
})
