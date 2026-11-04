import assert from 'node:assert/strict'
import test from 'node:test'
import { applyApprovalMode, defaultRunPolicy, runPolicyDigestInput } from '@mikka/protocol/agent-policy'
import { constrainedAssignmentPolicy, intersectRunPolicy } from '../lib/run-assignment-policy'

test('frozen checks preserve their exact evidence policy under the current ceiling', () => {
  const current = defaultRunPolicy()
  const frozen = applyApprovalMode({ ...current, networkAllow: [] }, 'read_only')
  assert.equal(constrainedAssignmentPolicy(current, undefined), current)
  assert.equal(runPolicyDigestInput(constrainedAssignmentPolicy(current, frozen)), runPolicyDigestInput(frozen))
})

test('a frozen check cannot remove a newer denial or read-only ceiling', () => {
  const frozen = applyApprovalMode(defaultRunPolicy(), 'read_only')
  const current = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, network: 'deny' as const } }
  assert.throws(() => constrainedAssignmentPolicy(current, frozen), /exceeds/)
  assert.throws(() => constrainedAssignmentPolicy(frozen, defaultRunPolicy()), /exceeds/)
})

test('a frozen assignment cannot restore revoked network domains or malformed policy', () => {
  const current = { ...defaultRunPolicy(), networkAllow: [] }
  assert.throws(() => constrainedAssignmentPolicy(current, applyApprovalMode(defaultRunPolicy(), 'read_only')), /exceeds/)
  assert.throws(() => constrainedAssignmentPolicy(current, { permissions: {} }))
})

test('provider continuation keeps source denials after target publication and computer grants', () => {
  const broad = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, git_push: 'allow' as const, computer_use: 'allow' as const } }
  const ceiling = applyApprovalMode({ ...defaultRunPolicy(), networkCeiling: ['api.example.invalid'],
    permissions: { ...defaultRunPolicy().permissions, git_push: 'deny' as const, computer_use: 'deny' as const } }, 'read_only')
  const before = structuredClone({ broad, ceiling })
  const effective = intersectRunPolicy(broad, ceiling)
  assert.equal(effective.readOnly, true)
  assert.equal(effective.permissions.install_dependency, 'deny')
  assert.equal(effective.permissions.write_outside_repo, 'deny')
  assert.equal(effective.permissions.git_push, 'deny')
  assert.equal(effective.permissions.computer_use, 'deny')
  assert.deepEqual(effective.networkCeiling, ['api.example.invalid'])
  assert.deepEqual({ broad, ceiling }, before, 'composition does not mutate either authority')
  assert.equal(intersectRunPolicy(broad, undefined), broad)
})

test('provider network ceilings intersect wildcard and port restrictions; a live target may narrow further', () => {
  const current = { ...defaultRunPolicy(), networkAllow: ['*.example.invalid'], networkCeiling: ['*.example.invalid:443'],
    permissions: { ...defaultRunPolicy().permissions, network: 'ask' as const } }
  const ceiling = { ...defaultRunPolicy(), networkAllow: ['api.example.invalid'], networkCeiling: ['api.example.invalid'],
    permissions: { ...defaultRunPolicy().permissions, network: 'ask' as const, git_push: 'deny' as const } }
  const next = intersectRunPolicy(current, ceiling)
  assert.deepEqual(next.networkCeiling, ['api.example.invalid:443'])
  assert.deepEqual(next.networkAllow, ['api.example.invalid:443'])
  assert.equal(next.permissions.git_push, 'deny')
  const denied = intersectRunPolicy({ ...current, permissions: { ...current.permissions, network: 'deny' as const } }, ceiling)
  assert.equal(denied.permissions.network, 'deny')
  assert.deepEqual(intersectRunPolicy({ ...current, networkCeiling: [] }, ceiling).networkCeiling, [])
})

test('unrestricted network and broker defaults do not invent new restrictions while explicit ceilings still bind', () => {
  const unrestricted = defaultRunPolicy()
  delete unrestricted.permissions.computer_use
  const scoped = { ...defaultRunPolicy(), networkAllow: ['api.example.invalid'],
    permissions: { ...defaultRunPolicy().permissions, network: 'ask' as const, computer_use: 'allow' as const } }
  assert.deepEqual(intersectRunPolicy(scoped, unrestricted).networkAllow, scoped.networkAllow)
  assert.equal(intersectRunPolicy(scoped, unrestricted).permissions.computer_use, 'allow')
  assert.deepEqual(intersectRunPolicy(unrestricted, scoped).networkAllow, scoped.networkAllow)
  assert.throws(() => intersectRunPolicy(scoped, { permissions: {} }))
})
