import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { agentProfileDigest, parseAgentProfile } from './agent-profile-definition'
import { agentProfileSkillSource, agentProfileSkillsCatalog, profileSkillRunAssignment, resolveAgentProfileSkills } from './agent-profile-skills'
import { AGENT_PROFILE_TEMPLATES, agentProfileTemplateDefinition } from './agent-profile-templates'
import { profileDecisionInput, type PublicAgentProfile } from './agent-profile-decision'

const digestOf = (value: string) => createHash('sha256').update(value).digest('hex')

test('official catalogue keeps the legacy three and adds reviewed coding capabilities without bodies', () => {
  const catalog = agentProfileSkillsCatalog()
  for (const id of ['implementation-evidence', 'independent-review', 'systematic-debugging', 'test-driven-development', 'verification-before-completion', 'performance-investigation', 'security-review']) {
    const skill = catalog.find(item => item.id === id)
    assert.ok(skill, id)
    assert.equal(skill.source, 'official')
    assert.equal(skill.available, true)
    assert.ok(skill.description.length > 0 && skill.description.length <= 500)
    assert.ok(!('content' in skill))
  }
  assert.equal(new Set(catalog.map(skill => skill.id)).size, catalog.length)
  assert.ok(catalog.every(skill => skill.digest.length === 64))
})

test('namespaced Skill references parse, stay stable, and reject unknown namespaces', () => {
  const personal = `personal:${randomUUID()}`, workspace = `workspace:${randomUUID()}`
  const definition = parseAgentProfile({ name: 'Mixed sources', skills: [personal, workspace, 'repository:test-driven-development', 'official:independent-review'] })
  assert.deepEqual(definition.skills, [personal, workspace, 'repository:test-driven-development', 'official:independent-review'])
  const repository = resolveAgentProfileSkills(['repository:test-driven-development'])
  assert.equal(repository[0].source, 'repository')
  assert.equal(repository[0].content, '')
  assert.equal(repository[0].digest.length, 64)
  assert.equal(repository[0].digest, resolveAgentProfileSkills(['repository:test-driven-development'])[0].digest)
  // Personal and workspace sources need the owner's current installations.
  assert.throws(() => resolveAgentProfileSkills([personal]), { code: 'agentProfileSkillUnavailable' })
  assert.throws(() => resolveAgentProfileSkills([workspace]), { code: 'agentProfileSkillUnavailable' })
  for (const invalid of ['personal:not-a-uuid', 'workspace:not-a-uuid', 'repository:../escape', 'Official:review', 'official:', 'private:review']) {
    assert.throws(() => parseAgentProfile({ name: 'Invalid source', skills: [invalid] }), invalid)
  }
})

test('source labels derive from the id namespace, with bare ids meaning official', () => {
  assert.equal(agentProfileSkillSource('systematic-debugging'), 'official')
  assert.equal(agentProfileSkillSource('official:systematic-debugging'), 'official')
  assert.equal(agentProfileSkillSource(`personal:${randomUUID()}`), 'personal')
  assert.equal(agentProfileSkillSource(`workspace:${randomUUID()}`), 'workspace')
  assert.equal(agentProfileSkillSource('repository:debugging'), 'repository')
})

test('the run assignment carries pinned bodies and repository names, never an unbounded envelope', () => {
  const official = resolveAgentProfileSkills(['systematic-debugging', 'implementation-evidence', 'repository:debugging'])
  const assignment = profileSkillRunAssignment(official)
  assert.deepEqual(assignment.profileSkills?.map(skill => skill.id), ['official:systematic-debugging', 'official:implementation-evidence'])
  assert.equal(assignment.profileSkills?.[0].digest, digestOf(official[0].content))
  assert.equal(assignment.profileSkills?.[0].instructions, official[0].content)
  assert.ok(assignment.profileSkills?.every(skill => !('content' in skill)))
  assert.deepEqual(assignment.repositorySkills, ['debugging'])
  assert.deepEqual(profileSkillRunAssignment([]), {})
  assert.deepEqual(profileSkillRunAssignment(resolveAgentProfileSkills(['repository:review'])), { repositorySkills: ['review'] })
})

test('Decision input receives skill names and purposes but no body, path or revision', () => {
  const skills = resolveAgentProfileSkills(['systematic-debugging', 'independent-review'])
  const selection = { id: randomUUID(), name: 'Backend', description: 'Backend implementation', roles: ['implementation'], harness: 'codex' as const, model: 'luna-fixture',
    skills: skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description, source: 'official' as const })) }
  const input = profileDecisionInput({ title: 'Fix checkout', content: 'Checkout returns 500', stage: 'execute' }, [selection])
  for (const skill of skills) {
    assert.ok(input.includes(skill.name))
    assert.ok(input.includes(skill.description))
    assert.ok(!input.includes(skill.content), 'a Skill body must never enter the Decision input')
    assert.ok(!input.includes(skill.digest))
  }
  for (const forbidden of ['instructions', 'sourceRevision', 'ownerId', 'connectionId']) assert.ok(!input.includes(`"${forbidden}"`))
})

test('the four role templates are copies with fixed contracts, auto agent and inherited model', () => {
  assert.deepEqual(AGENT_PROFILE_TEMPLATES.map(template => template.id), ['investigator', 'planner', 'implementer', 'reviewer'])
  const copy = { name: 'Role', description: 'Purpose' }
  for (const template of AGENT_PROFILE_TEMPLATES) {
    const definition = agentProfileTemplateDefinition(template.id, copy)
    assert.equal(definition.name, 'Role')
    assert.equal(definition.description, 'Purpose')
    assert.equal(definition.harness, 'auto')
    assert.deepEqual(definition.model, { mode: 'inherit' })
    assert.deepEqual(definition.roles, [...template.roles])
    assert.deepEqual(definition.skills, [...template.skills])
    assert.ok(definition.instructions.length > 0 && definition.instructions.length <= 24_000)
    assert.ok(definition.skills.every(id => agentProfileSkillsCatalog().some(skill => skill.id === id)), 'template Skills must exist in the official catalogue')
    // Editing the returned copy never changes the template or another copy.
    definition.skills.push('systematic-debugging')
    assert.deepEqual(agentProfileTemplateDefinition(template.id, copy).skills, [...template.skills])
    assert.ok(agentProfileDigest(definition, []) !== agentProfileDigest(agentProfileTemplateDefinition(template.id, copy), []))
  }
  assert.throws(() => agentProfileTemplateDefinition('unknown' as never, copy))
  // A created template is an ordinary Profile: it never creates a Bot, Agent or extra row.
  const generated = agentProfileTemplateDefinition('reviewer', copy)
  assert.equal(generated.enabled, true)
  assert.ok(!('botId' in generated) && !('agentId' in generated))
})

test('templates stay out of the automatic Profile catalogue until a person saves one', () => {
  // The Decision catalog is built only from stored rows; templates are editor data.
  const publicProfile = (name: string): PublicAgentProfile => ({ id: randomUUID(), name, description: '', roles: [], harness: 'codex', model: 'luna-fixture' })
  const stored = [publicProfile('My reviewer')]
  const input = profileDecisionInput({ title: 'Task', content: 'Body', stage: 'execute' }, stored)
  for (const template of AGENT_PROFILE_TEMPLATES) assert.ok(!input.includes(`"${template.id}"`))
})
