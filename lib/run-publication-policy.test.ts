import assert from 'node:assert/strict'
import test from 'node:test'
import { publicationBranch, publicationGate, repositoryPushApproved } from './run-publication-policy'
import type { RunReport } from '@mikka/protocol/run'

const report: RunReport = { summary: 'Done.', filesChanged: ['a.ts'], verify: { status: 'passed' }, openQuestions: [], nextStep: null, publish: { branch: 'mikka/mik-42', commit: 'a'.repeat(40), pushed: true, remote: 'origin' } }
const ready = { stopReason: 'submitted', kind: 'implement', report, assignment: { branch: 'mikka/mik-42', pushApproved: true } }

test('only an explicit owner receipt approves repository pushes', () => {
  const approval = { approved: true, approvedByUserId: 'owner', approvedAt: '2026-10-28T02:00:00Z', remote: 'origin' }
  assert.equal(repositoryPushApproved(approval, 'owner'), true)
  for (const value of [undefined, null, { approved: true }, { ...approval, approved: false }, { ...approval, approvedByUserId: 'peer' }, { ...approval, approvedAt: 'invalid' }, { ...approval, remote: 'attacker' }]) assert.equal(repositoryPushApproved(value, 'owner'), false)
})

test('ADR 0024 uses existing task team and number without inventing a team', () => {
  assert.equal(publicationBranch('MIK-42'), 'mikka/mik-42')
  assert.equal(publicationBranch('ALEX-7'), 'mikka/alex-7')
  for (const identifier of [null, '', '#7', 'MIK-0', 'MIK-01', 'MIK-999999999999999999999', 'MIK/42']) assert.equal(publicationBranch(identifier), null)
})

test('only approved, matching pushes enter PR publication', () => {
  assert.deepEqual(publicationGate(ready), { state: 'pending' })
  assert.deepEqual(publicationGate({ ...ready, assignment: null }), { state: 'blocked', error: 'publication_missing' })
  assert.deepEqual(publicationGate({ ...ready, assignment: { branch: null, pushApproved: true } }), { state: 'blocked', error: 'task_identifier_required' })
  assert.deepEqual(publicationGate({ ...ready, assignment: { ...ready.assignment, pushApproved: false } }), { state: 'blocked', error: 'push_not_approved' })
  for (const patch of [{ branch: 'main' }, { remote: 'attacker' }, { commit: null }, { commit: 'bad-sha' }]) assert.deepEqual(publicationGate({ ...ready, report: { ...report, publish: { ...report.publish!, ...patch } } }), { state: 'blocked', error: 'publication_mismatch' })
  assert.deepEqual(publicationGate({ ...ready, report: { ...report, publish: { ...report.publish!, pushed: false } } }), { state: 'blocked', error: 'push_failed' })
})

test('plan, failed verification, cancellation, and unchanged base never open a PR', () => {
  for (const input of [
    { ...ready, kind: 'plan' }, { ...ready, stopReason: 'cancelled' },
    { ...ready, report: { ...report, verify: { status: 'failed' as const } } },
    { ...ready, report: { ...report, publish: { ...report.publish!, skipped: 'no_changes' as const, pushed: false } } },
  ]) assert.deepEqual(publicationGate(input), { state: 'skipped' })
})

test('unverified submissions remain eligible for a draft without fabricating a pass', () => {
  assert.deepEqual(publicationGate({ ...ready, report: { ...report, verify: { status: 'not_run' } } }), { state: 'pending' })
})
