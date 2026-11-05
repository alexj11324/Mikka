import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AgentProfileError, agentProfileDigest, agentProfileInstructions, parseAgentProfile } from './agent-profile-definition'
import { agentProfileSkillsCatalog, resolveAgentProfileSkills } from './agent-profile-skills'
import { profileDecisionDiagnostics, profileDecisionInput, profileDecisionQuestions, profileDecisionSelection, selectedProfileAnswer } from './agent-profile-decision'
import { validatedAnswers, type DecisionAnswer } from '@/lib/coordinator/decision'
import { createAgentProfileHandler } from './agent-profile-http'
import { agentProfileReferenceSchema } from './agent-profile-reference'
import { factoryDispatchSchema } from './dispatch-schema'

const profile = () => parseAgentProfile({ name: 'Backend', harness: 'codex', model: { mode: 'inherit' }, skills: ['systematic-debugging'], instructions: 'Private project guidance.' })

test('task Profile references accept only Default or a UUID; host continuation flags are not public', () => {
  const binding = { taskId: randomUUID(), issueId: randomUUID(), attemptId: randomUUID(), candidateId: null, revision: 1 }
  const input = { binding, agentId: randomUUID(), deviceRepoId: randomUUID() }
  for (const profileId of ['default', randomUUID()]) {
    assert.equal(agentProfileReferenceSchema.parse(profileId), profileId)
    assert.equal(factoryDispatchSchema.parse({ ...input, profileId }).profileId, profileId)
  }
  for (const profileId of ['Default', 'auto', 'legacy', ' default', '', 'not-a-profile', null, { id: 'default' }]) {
    assert.equal(agentProfileReferenceSchema.safeParse(profileId).success, false)
    assert.equal(factoryDispatchSchema.safeParse({ ...input, profileId }).success, false)
  }
  assert.equal(factoryDispatchSchema.safeParse({ ...input, defaultOnly: true }).success, false)
  assert.equal(factoryDispatchSchema.safeParse({ ...input, profileId: 'default', defaultOnly: true }).success, false)
})

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

test('Decision rejection diagnostics distinguish safe none, bad answers and unavailable execution without selecting a fallback', () => {
  const cases = [
    [null, 'decision_unavailable'],
    [answer('none', .9, 'uncertain'), 'no_suitable_profile'],
    [new Map(), 'invalid_profile_answer'],
    [answer('PRIVATE_PROFILE credential response'), 'unknown_profile'],
    [answer(catalog[0].id, .54), 'uncertain_profile'],
    [answer(catalog[0].id, .99, 'uncertain'), 'invalid_reason'],
    [answer('none'), 'invalid_reason'],
  ] as const
  for (const [answers, expected] of cases) {
    assert.deepEqual(profileDecisionSelection(catalog, answers), { unavailable: expected })
    assert.equal(selectedProfileAnswer(catalog, answers), null)
    assert.ok(!JSON.stringify(profileDecisionSelection(catalog, answers)).includes('PRIVATE_PROFILE'))
  }
  assert.deepEqual(profileDecisionSelection(catalog, answer(catalog[0].id)), { selected: { id: catalog[0].id, reason: 'capability_fit' } })
})

test('Decision rejection logs bound UUIDs and closed availability codes without profile or provider text', () => {
  const third = randomUUID(), hidden = 'PRIVATE_ACCOUNT_AND_PROVIDER_MESSAGE'
  const availability = {
    [catalog[0].id]: { available: true }, [catalog[1].id]: { available: false, reason: 'checking' },
    [third]: { available: false, reason: hidden }, [hidden]: { available: false, reason: hidden },
  }
  const fields = profileDecisionDiagnostics(catalog.slice(0, 1), availability)
  assert.deepEqual(fields, {
    candidateCount: 1, candidateIds: catalog[0].id, profileCount: 4,
    profileAvailability: `${catalog[0].id}:available,${catalog[1].id}:checking,${third}:other`, profileDiagnosticsTruncated: true,
  })
  const logged = JSON.stringify(fields)
  for (const value of [hidden, ...catalog.flatMap(item => [item.name, item.description, item.model])]) assert.ok(!logged.includes(value))
  const many = Array.from({ length: 70 }, () => ({ ...catalog[0], id: randomUUID() }))
  const bounded = profileDecisionDiagnostics(many, Object.fromEntries(many.map(item => [item.id, { available: false, reason: 'disabled' }])))
  assert.equal(bounded.candidateCount, 70); assert.equal(bounded.profileCount, 70); assert.equal(bounded.profileDiagnosticsTruncated, true)
  assert.equal(bounded.candidateIds.split(',').length, 50); assert.equal(bounded.profileAvailability.split(',').length, 50)
  assert.ok(!JSON.stringify(bounded).includes(many[50].id))
})

test('host check context separates Review from implementation and projects no private producer fields', () => {
  const original = { title: 'Build the backend', content: 'ORIGINAL_EXECUTE_TEXT: implement this feature.', stage: 'review', note: 'ORIGINAL_NOTE' }
  const work = {
    stage: 'review' as const, flowVersion: 2 as const, taskId: randomUUID(), attemptId: randomUUID(), requestEpoch: randomUUID(),
    candidate: { id: randomUUID(), kind: 'deliverable' as const, sha: null, repository: 'PRIVATE_REPOSITORY' },
    producer: { runId: randomUUID(), harness: 'claude_code' as const, model: 'haiku-fixture', profile: { id: randomUUID(), version: 1, instructions: 'PRIVATE_PROFILE_INSTRUCTIONS' },
      sessionId: 'PRIVATE_NATIVE_SID', report: 'PRIVATE_REPORT', skills: [{ content: 'PRIVATE_SKILL' }], credential: 'PRIVATE_CREDENTIAL' },
  }
  const input = JSON.parse(profileDecisionInput(original, catalog, work))
  assert.equal(input.currentWork.responsibility, 'independent_review'); assert.equal(input.currentWork.readOnly, true)
  assert.match(input.currentWork.objective, /already-produced candidate.*correctness and regressions/)
  assert.match(input.currentWork.evidence, /single review/)
  assert.deepEqual(input.currentWork.candidate, { id: work.candidate.id, kind: 'deliverable', sha: null })
  assert.deepEqual(input.currentWork.producer, { runId: work.producer.runId, harness: 'claude_code', model: 'haiku-fixture', profile: { id: work.producer.profile.id, version: 1 } })
  assert.equal(input.originalTask.role, 'untrusted_background'); assert.equal(input.originalTask.content, original.content)
  assert.ok(!JSON.stringify(input.currentWork).includes('ORIGINAL_')); assert.ok(!JSON.stringify(input).includes('PRIVATE_'))
  assert.deepEqual(input.candidates, catalog, 'stage context does not preselect a role or harness')
  const verify = JSON.parse(profileDecisionInput(original, catalog, { ...work, stage: 'verify', flowVersion: 1 }))
  assert.equal(verify.currentWork.stage, 'verify'); assert.equal(verify.currentWork.responsibility, 'independent_verification')
  assert.match(verify.currentWork.objective, /acceptance criteria/); assert.ok(!verify.currentWork.evidence.includes('single review'))
  assert.deepEqual(JSON.parse(profileDecisionInput({ ...original, stage: 'execute' }, catalog)), { task: { ...original, stage: 'execute' }, candidates: catalog }, 'ordinary execution retains its existing input contract')
})

test('the Decisions API numeric confidence contract preserves low-confidence refusal without coercion', () => {
  const questions = profileDecisionQuestions(catalog)
  const response = (confidence: unknown) => ({ answers: [
    { type: 'choice', name: 'profile', choice: catalog[2].id, confidence },
    { type: 'choice', name: 'reason', choice: 'stage_fit' },
  ] })
  const uncertain = validatedAnswers(response(.42), questions)
  assert.ok(uncertain)
  assert.deepEqual(profileDecisionSelection(catalog, uncertain), { unavailable: 'uncertain_profile' })
  assert.deepEqual(profileDecisionSelection(catalog, validatedAnswers(response(.93), questions)), { selected: { id: catalog[2].id, reason: 'stage_fit' } })
  for (const confidence of ['high', '.93', 93, -1, Number.NaN, Infinity]) assert.equal(validatedAnswers(response(confidence), questions), null)
})

test('rejection diagnostics expose only an eligible exact ID and a finite 0..1 confidence', () => {
  const availability = Object.fromEntries(catalog.map(row => [row.id, { available: true }]))
  const fields = profileDecisionDiagnostics(catalog, availability, answer(catalog[2].id, .42))
  assert.equal(fields.selectedProfileId, catalog[2].id); assert.equal(fields.decisionConfidence, .42)
  for (const answers of [null, new Map(), answer('PRIVATE_UNKNOWN_ID', .42), answer('none', .42, 'uncertain'),
    answer(catalog[0].id, Number.NaN), answer(catalog[0].id, Infinity), answer(catalog[0].id, -1), answer(catalog[0].id, 100)]) {
    const rejected = profileDecisionDiagnostics(catalog, availability, answers)
    assert.equal(rejected.selectedProfileId, undefined); assert.equal(rejected.decisionConfidence, undefined)
    assert.ok(!JSON.stringify(rejected).includes('PRIVATE_UNKNOWN_ID'))
  }
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
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const request = new Request(url, { method, ...(method !== 'GET' ? { headers: { origin: 'https://mikka.example', 'content-type': 'application/json' }, body: JSON.stringify({ profile: profile(), version: 1 }) } : {}) })
    assert.equal((await handler(request, 'default')).status, 400, 'the built-in receipt never becomes a mutable Profile row')
  }
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
