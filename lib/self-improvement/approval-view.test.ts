import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { currentSkillApproval, hasRecordedSkillActivation } from './approval-view'

test('recorded activation belongs to the current candidate and its unrevoked approval', () => {
  const approval = { id: 'a', candidateId: 'c', action: 'activate_skill', revokedAt: null, expiresAt: '2026-10-27T00:00:00Z', targetEnvironment: 'preview' }
  const publication = { approvalId: 'a', candidateId: 'c', action: 'activate_skill', status: 'succeeded', receipt: { verified: true } }
  assert.equal(hasRecordedSkillActivation('c', [approval], [publication]), true)
  assert.equal(hasRecordedSkillActivation('c', [{ ...approval, revokedAt: '2026-10-26' }], [publication]), false)
  assert.equal(hasRecordedSkillActivation('c', [{ ...approval, id: 'other' }], [publication]), false)
  assert.equal(hasRecordedSkillActivation('new', [approval], [publication]), false)
  assert.equal(hasRecordedSkillActivation('c', [approval], [{ ...publication, receipt: null }]), false)
})

test('resume selects only a current unexpired and unrevoked candidate approval', () => {
  const current = { id: 'current', candidateId: 'c', action: 'activate_skill', revokedAt: null, expiresAt: '2026-10-27T00:00:00Z', targetEnvironment: 'preview' }
  const stale = { ...current, id: 'stale', candidateId: 'old' }
  const now = Date.parse('2026-10-26T00:00:00Z')
  assert.equal(currentSkillApproval('c', [current, stale], now)?.id, 'current')
  assert.equal(currentSkillApproval('c', [{ ...current, revokedAt: '2026-10-26' }], now), undefined)
  assert.equal(currentSkillApproval('c', [current], Date.parse('2026-10-28T00:00:00Z')), undefined)
})
