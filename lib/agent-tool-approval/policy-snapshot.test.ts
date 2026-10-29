import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTrustedRunPolicy } from './policy-snapshot'

test('trusted workspace policy and personal read-only restrictions combine without widening', () => {
  const workspace = { permissions: { install_dependency: 'allow', network: 'deny' }, networkAllow: [] }
  const normal = resolveTrustedRunPolicy({ workspace, personalApprovalMode: 'ask' })
  assert.equal(normal.permissions.install_dependency, 'allow')
  assert.equal(normal.permissions.network, 'deny')
  const restricted = resolveTrustedRunPolicy({ workspace, personalApprovalMode: 'read_only' })
  assert.equal(restricted.readOnly, true)
  assert.equal(restricted.permissions.install_dependency, 'deny')
  assert.equal(restricted.permissions.network, 'deny')
})
test('invalid stored decisions, domains or personal modes fail closed', () => {
  assert.throws(() => resolveTrustedRunPolicy({ workspace:{ permissions:{ write_outside_repo:'allow' }, networkAllow:[] }, personalApprovalMode:'ask' }))
  assert.throws(() => resolveTrustedRunPolicy({ workspace:{ permissions:{}, networkAllow:['*'] }, personalApprovalMode:'ask' }))
  assert.throws(() => resolveTrustedRunPolicy({ workspace:null, personalApprovalMode:'bypassPermissions' }))
})
test('absent settings resolve to documented ask defaults', () => {
  const policy = resolveTrustedRunPolicy({ workspace:null, personalApprovalMode:null })
  assert.equal(policy.permissions.git_push, 'ask')
  assert.equal(policy.permissions.network, 'ask')
})
