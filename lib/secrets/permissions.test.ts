import assert from 'node:assert/strict'
import test from 'node:test'
import type { SecretScopeType } from './format'
import { memberMayWrite, SECRET_POLICY, secretActionAllowed, type SecretAction } from './permissions'

const scopes: SecretScopeType[] = ['workspace', 'repository']
const expectedMemberWrite = (scopeType: SecretScopeType) => scopeType === 'repository'

test('matrix: admin may do everything', () => {
  const actions: SecretAction[] = ['secret.list', 'secret.create', 'secret.replace', 'secret.delete', 'e2b.status', 'e2b.write']
  for (const action of actions) for (const scopeType of scopes)
    assert.equal(secretActionAllowed('admin', action, [{ scopeType }], false), true, `${action} ${scopeType}`)
})

test('matrix: member cells (defaults from plan 1.3 / 7.12)', () => {
  assert.equal(secretActionAllowed('member', 'secret.list'), true)
  for (const scopeType of scopes) {
    const t = { scopeType }, want = expectedMemberWrite(scopeType)
    assert.equal(memberMayWrite(t), want, scopeType)
    assert.equal(secretActionAllowed('member', 'secret.create', [t]), want, `create ${scopeType}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [t, t]), want, `replace own ${scopeType}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [t, t], false), want, `replace others' ${scopeType}`)
    assert.equal(secretActionAllowed('member', 'secret.delete', [t]), false, `delete ${scopeType}`)
  }
  assert.equal(secretActionAllowed('member', 'e2b.status'), true)
  assert.equal(secretActionAllowed('member', 'e2b.write'), false)
  assert.equal(secretActionAllowed('member', 'secret.create', []), false, 'no target, no write')
})

test('matrix: replace checks old and new, so a member cannot move an entry up or pull one down', () => {
  const ok = { scopeType: 'repository' as const }
  for (const bad of [{ scopeType: 'workspace' as const }]) {
    assert.equal(secretActionAllowed('member', 'secret.replace', [ok, bad]), false, `move to ${JSON.stringify(bad)}`)
    assert.equal(secretActionAllowed('member', 'secret.replace', [bad, ok]), false, `move from ${JSON.stringify(bad)}`)
  }
})

test('the pending defaults are single constants', () => {
  assert.deepEqual(SECRET_POLICY.memberScopes, ['repository'])
  assert.equal(SECRET_POLICY.memberMayReplaceOthers, true)
})
