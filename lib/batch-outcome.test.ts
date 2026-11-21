import assert from 'node:assert/strict'
import test from 'node:test'
import { outcomeCounts, planInvitations, usedItems } from './batch-outcome'

// Per-item batch results (ALE-28), pure: who to act on and why the rest is
// skipped. The invitation action that consumes them is exercised against real
// PostgreSQL in tests/audit-delivery.db.test.ts.

const members = new Set(['already@example.invalid'])

test('one already-member address does not throw away the rest of the batch', () => {
  const plan = planInvitations(['new@example.invalid', 'already@example.invalid', 'other@example.invalid'], members)
  assert.deepEqual(usedItems(plan), ['new@example.invalid', 'other@example.invalid'])
  assert.deepEqual(plan[1], { item: 'already@example.invalid', used: false, reason: 'alreadyMember' })
})

test('a pending invitation is invited again, which is how its stale link is renewed', () => {
  assert.deepEqual(planInvitations(['pending@example.invalid'], members), [{ item: 'pending@example.invalid', used: true }])
})

test('repeats inside one batch are reported once and invited once', () => {
  const plan = planInvitations(['a@example.invalid', 'A@EXAMPLE.INVALID', ' a@example.invalid '], members)
  assert.deepEqual(usedItems(plan), ['a@example.invalid'])
  assert.deepEqual(plan.map(outcome => outcome.used), [true, false, false])
  assert.deepEqual(plan.filter(outcome => !outcome.used).map(outcome => outcome.used === false && outcome.reason), ['duplicate', 'duplicate'])
})

test('addresses are compared the way the unique index compares them', () => {
  const plan = planInvitations([' Already@Example.Invalid '], members)
  assert.deepEqual(plan, [{ item: 'already@example.invalid', used: false, reason: 'alreadyMember' }])
})

test('the summary counts what happened and why', () => {
  const plan = planInvitations(['new@example.invalid', 'already@example.invalid', 'pending@example.invalid', 'new@example.invalid'], members)
  assert.deepEqual(outcomeCounts(plan), { used: 2, skipped: { alreadyMember: 1, duplicate: 1 } })
})

test('an all-new batch reports nothing skipped', () => {
  assert.deepEqual(outcomeCounts(planInvitations(['a@example.invalid', 'b@example.invalid'], members)), { used: 2, skipped: {} })
  assert.deepEqual(planInvitations([], members), [])
})
