import assert from 'node:assert/strict'
import test from 'node:test'
import { applyApprovalMode, defaultRunPolicy, runPolicyDigestInput } from '@mikka/protocol/agent-policy'
import { constrainedAssignmentPolicy } from '../lib/run-assignment-policy'

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
