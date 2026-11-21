import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AgentProfileError, agentProfileDigest, agentProfileInstructions, contentOnlyAgentProfile, parseAgentProfile, profileFixedModel, profileHarness } from './agent-profile-definition'
import { agentProfileSkillsCatalog, resolveAgentProfileSkills } from './agent-profile-skills'
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
  assert.ok(instructions.includes(definition.instructions))
  // Progressive disclosure: the brief names the capability and its loader, not the body.
  assert.ok(!instructions.includes(skills[0].content), 'an assigned Skill body must not be inlined into the brief')
  assert.ok(instructions.includes('load_skill'))
  assert.ok(instructions.includes('official:systematic-debugging'))
  assert.ok(instructions.includes(skills[0].description))
  assert.throws(() => resolveAgentProfileSkills(['unreviewed-skill']), { code: 'agentProfileSkillUnavailable' })
  assert.ok(agentProfileSkillsCatalog().every(skill => !('content' in skill)))
  // The official envelope keeps its pre-existing fields so frozen digests survive.
  assert.ok(skills.every(skill => !('source' in skill)))
})

test('saving keeps only the content: model, harness, effort and tags are dropped', () => {
  const saved = contentOnlyAgentProfile(parseAgentProfile({ name: 'Reviewer', roles: ['review'], harness: 'codex', effort: 'high', instructions: 'Read first.', skills: [] }))
  assert.deepEqual({ roles: saved.roles, harness: saved.harness, model: saved.model, effort: saved.effort }, { roles: [], harness: 'auto', model: { mode: 'inherit' }, effort: undefined })
  assert.equal(saved.instructions, 'Read first.')
})

test('a content-only selection pins no model or harness, even from an older stored row', () => {
  const definition = parseAgentProfile({ name: 'Old', harness: 'codex', model: { mode: 'fixed', harness: 'codex', model: 'gpt-x', source: { kind: 'api_key', keyId: randomUUID() } } })
  assert.equal(profileFixedModel({ definition, contentOnly: true }), undefined)
  assert.equal(profileHarness({ definition, contentOnly: true }), undefined)
  // A selection frozen before content-only Profiles keeps its fence.
  assert.equal(profileFixedModel({ definition })?.model, 'gpt-x')
  assert.equal(profileHarness({ definition }), 'codex')
})

test('Profile HTTP guards owner scope, same origin, strict bodies, and optimistic version errors', async () => {
  const workspaceId = randomUUID(), id = randomUUID(), calls: string[] = []
  const stored = { ...profile(), icon: 'chevrons' as const, color: 'teal' as const, id, version: 1, digest: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null }
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

test('a Profile mark is derived from its roles, then name and description, and stays steady', async () => {
  const { deriveProfileMark, resolveProfileMark, PROFILE_GLYPHS, PROFILE_COLORS, DEFAULT_PROFILE_MARK } = await import('./agent-profile-mark')
  assert.equal(deriveProfileMark({ name: 'Anything', roles: ['Review'] }).icon, 'lens')
  assert.equal(deriveProfileMark({ name: '实现', roles: [] }).icon, 'chevrons')
  assert.equal(deriveProfileMark({ name: 'Writer', roles: ['文档'] }).icon, 'lines')
  assert.equal(deriveProfileMark({ name: 'QA', roles: ['testing', 'review'] }).icon, 'check', 'the first matching role decides')
  assert.equal(deriveProfileMark({ name: 'Mixed', roles: ['review and test'] }).icon, 'lens', 'the earliest word in a role decides')
  assert.equal(deriveProfileMark({ name: 'Nova', description: 'Plans the work and writes specs' }).icon, 'stairs')
  assert.equal(deriveProfileMark({ name: '前端', roles: ['Frontend'] }).icon, 'diamond')
  assert.equal(deriveProfileMark({ name: 'Release', roles: ['deploy'] }).icon, 'arrow')
  // Words inside other words do not match ("prefix" is not "fix", "docker" is not "doc").
  assert.notEqual(deriveProfileMark({ name: 'prefix docker' }).icon, 'lines')
  const unnamed = deriveProfileMark({ name: 'Zephyr' })
  assert.deepEqual(deriveProfileMark({ name: ' zephyr ' }), unnamed, 'same name, same mark')
  assert.notEqual(unnamed.icon, 'square', 'the Default glyph is never derived for a custom Profile')
  for (const name of ['a', 'b', 'Backend', 'Ops', '审查', 'x'.repeat(80)]) {
    const mark = deriveProfileMark({ name })
    assert.ok(PROFILE_GLYPHS.includes(mark.icon)); assert.ok(PROFILE_COLORS.includes(mark.color)); assert.notEqual(mark.color, DEFAULT_PROFILE_MARK.color)
  }
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, { icon: 'diamond', color: 'pink' }), { icon: 'diamond', color: 'pink' })
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, null), deriveProfileMark({ name: 'Review' }))
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, { icon: 'skull', color: 'red' }), deriveProfileMark({ name: 'Review' }), 'unknown ids fall back')
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, { icon: 'arrow', color: null }), { icon: 'arrow', color: deriveProfileMark({ name: 'Review' }).color })
  assert.deepEqual(DEFAULT_PROFILE_MARK, { icon: 'square', color: 'blue' })
  // Chromatic only: no white or grey left to pick.
  assert.deepEqual([...PROFILE_COLORS], ['blue', 'teal', 'emerald', 'violet', 'pink'])
  // Colours stored or frozen before 2026-11-20 keep a colour of their own.
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, { icon: 'lens', color: 'ink' }), { icon: 'lens', color: 'blue' })
  assert.deepEqual(resolveProfileMark({ name: 'Review' }, { icon: 'lens', color: 'graphite' }), { icon: 'lens', color: 'violet' })
})

test('a Profile mark is a closed set beside the definition and never enters its digest', async () => {
  const { profileMarkInputSchema } = await import('./agent-profile-mark')
  assert.deepEqual(profileMarkInputSchema.parse({ icon: 'lens', color: 'teal' }), { icon: 'lens', color: 'teal' })
  assert.deepEqual(profileMarkInputSchema.parse({ icon: null }), { icon: null })
  for (const bad of [{ icon: 'skull' }, { color: 'red' }, { color: 'amber' }, { color: 'ink' }, { color: 'graphite' }, { icon: 'lens', svg: '<svg/>' }, { icon: '' }]) assert.equal(profileMarkInputSchema.safeParse(bad).success, false)
  assert.throws(() => parseAgentProfile({ ...profile(), icon: 'lens' }), 'the mark is not a definition field')
  const workspaceId = randomUUID(), id = randomUUID()
  const seen: unknown[] = []
  const stored = { ...profile(), icon: 'lens' as const, color: 'teal' as const, id, version: 1, digest: 'a'.repeat(64), createdAt: '', updatedAt: '', archivedAt: null }
  const handler = createAgentProfileHandler({
    authenticate: async () => ({ ownerId: 'owner', workspaceId }), management: async () => ({ profiles: [] }),
    store: {
      get: async () => stored, history: async () => [], archive: async () => stored,
      create: async (_scope, _profile, _requestId, mark) => { seen.push(['create', mark]); return stored },
      update: async (_scope, _id, _version, _profile, mark) => { seen.push(['update', mark]); return stored },
    },
  })
  const url = `https://mikka.example/api/factory/agent-profiles?workspaceId=${workspaceId}`
  const send = (method: string, body: unknown, profileId?: string) => handler(new Request(url, { method, headers: { origin: 'https://mikka.example', 'content-type': 'application/json' }, body: JSON.stringify(body) }), profileId)
  assert.equal((await send('POST', { profile: profile(), mark: { icon: 'lens', color: 'teal' } })).status, 201)
  assert.equal((await send('POST', { profile: profile(), mark: { icon: 'skull' } })).status, 400)
  assert.equal((await send('POST', { profile: profile(), mark: { color: 'red' } })).status, 400)
  assert.equal((await send('PATCH', { profile: profile(), version: 1 }, id)).status, 200)
  assert.equal((await send('PATCH', { profile: profile(), version: 1, mark: { icon: null } }, id)).status, 200)
  assert.deepEqual(seen, [['create', { icon: 'lens', color: 'teal' }], ['update', undefined], ['update', { icon: null }]])
  assert.equal(agentProfileDigest(profile(), []), agentProfileDigest(parseAgentProfile(profile()), []), 'the digest is over the definition alone')
})

test('a thread reads a custom Profile with its mark; Default and malformed values read as none', async () => {
  const { threadProfile } = await import('@/lib/issue-threads')
  const id = randomUUID()
  assert.deepEqual(threadProfile({ profileId: id, name: 'Reviewer', roles: ['review'], description: '', icon: null, color: null }), { id, name: 'Reviewer', icon: 'lens', color: (await import('./agent-profile-mark')).deriveProfileMark({ name: 'Reviewer', roles: ['review'] }).color })
  assert.deepEqual(threadProfile({ profileId: id, name: 'Reviewer', roles: ['review'], icon: 'arrow', color: 'pink' }), { id, name: 'Reviewer', icon: 'arrow', color: 'pink' })
  assert.equal(threadProfile({ profileId: 'default', name: 'Default Agent' }), null)
  for (const bad of [null, undefined, 'x', { name: 'No id' }, { profileId: id }]) assert.equal(threadProfile(bad), null)
})
