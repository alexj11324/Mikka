import assert from 'node:assert/strict'
import test from 'node:test'
import { SECRET_ENVIRONMENTS, type SecretEnvironment, type SecretScopeType } from './format'
import { memberMayWrite, SECRET_POLICY, secretActionAllowed, type SecretAction } from './permissions'

const scopes: SecretScopeType[] = ['workspace', 'repository']
const expectedMemberWrite = (scopeType: SecretScopeType, environment: SecretEnvironment) => scopeType === 'repository' && (environment === 'preview' || environment === 'development')

test('matrix: admin may do everything', () => {
  const actions: SecretAction[] = ['secret.list', 'secret.create', 'secret.replace', 'secret.delete', 'e2b.status', 'e2b.write', 'network.read', 'network.write']
  for (const action of actions) for (const scopeType of scopes) for (const environment of SECRET_ENVIRONMENTS)
    assert.equal(secretActionAllowed('admin', action, [{ scopeType, environment }], false), true, `${action} ${scopeType} ${environment}`)
})

test('matrix: member cells (defaults from plan 1.3 / 7.12)', () => {
  assert.equal(secretActionAllowed('member', 'secret.list'), true)
  for (const scopeType of scopes) for (const environment of SECRET_ENVIRONMENTS) {
    const t = { scopeType, environment }, want = expectedMemberWrite(scopeType, environment)
    assert.equal(memberMayWrite(t), want, `${scopeType}/${environment}`)
    assert.equal(secretActionAllowed('member', 'secret.create', [t]), want, `create ${scopeType}/${environment}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [t, t]), want, `replace own ${scopeType}/${environment}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [t, t], false), want, `replace others' ${scopeType}/${environment}`)
    assert.equal(secretActionAllowed('member', 'secret.delete', [t]), false, `delete ${scopeType}/${environment}`)
  }
  assert.equal(secretActionAllowed('member', 'e2b.status'), true)
  assert.equal(secretActionAllowed('member', 'e2b.write'), false)
  assert.equal(secretActionAllowed('member', 'network.read'), false)
  assert.equal(secretActionAllowed('member', 'network.write'), false)
  assert.equal(secretActionAllowed('member', 'secret.create', []), false, 'no target, no write')
})

test('matrix: replace checks old and new, so a member cannot move an entry up or pull one down', () => {
  const ok = { scopeType: 'repository' as const, environment: 'preview' as const }
  for (const bad of [{ scopeType: 'repository' as const, environment: 'production' as const }, { scopeType: 'repository' as const, environment: 'all' as const }, { scopeType: 'workspace' as const, environment: 'preview' as const }]) {
    assert.equal(secretActionAllowed('member', 'secret.replace', [ok, bad]), false, `move to ${JSON.stringify(bad)}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [bad, ok]), false, `move from ${JSON.stringify(bad)}`)
  }
})

test('the five pending defaults are single constants', () => {
  assert.deepEqual(SECRET_POLICY.memberScopes, ['repository'])
  assert.deepEqual(SECRET_POLICY.productionLike, ['production', 'all'])
  assert.equal(SECRET_POLICY.memberMayReplaceOthers, true)
  assert.deepEqual(SECRET_ENVIRONMENTS, ['all', 'production', 'preview', 'development'])
})
