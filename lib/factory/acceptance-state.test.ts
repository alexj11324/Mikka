import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptanceState, acceptanceStateKey } from './acceptance-state'

const now = Date.parse('2026-10-29T12:00:00Z')
const approval = (patch: Record<string, unknown> = {}) => ({ id: 'a1', candidateId: 'c1', expiresAt: '2026-10-29T13:00:00Z', revokedAt: null, createdAt: '2026-10-29T10:00:00Z', ...patch })
const state = (input: Partial<Parameters<typeof acceptanceState>[0]>) => acceptanceState({ stage: 'publish', candidateId: 'c1', approvals: [], publications: [], now, ...input }).state

test('derives every acceptance state from the ledger', () => {
  assert.equal(state({ stage: 'approval' }), 'pending')
  assert.equal(state({}), 'unavailable')
  assert.equal(state({ approvals: [approval()] }), 'approved')
  assert.equal(state({ approvals: [approval()], publications: [{ approvalId: 'a1', status: 'reserved' }] }), 'publishing')
  assert.equal(state({ approvals: [approval()], publications: [{ approvalId: 'a1', status: 'uncertain' }] }), 'checking')
  assert.equal(state({ approvals: [approval()], publications: [{ approvalId: 'a1', status: 'failed' }] }), 'failed')
  assert.equal(state({ approvals: [approval()], publications: [{ approvalId: 'a1', status: 'succeeded' }] }), 'live')
  assert.equal(state({ approvals: [approval({ revokedAt: '2026-10-29T11:00:00Z' })] }), 'revoked')
  assert.equal(state({ approvals: [approval({ expiresAt: '2026-10-29T11:00:00Z' })] }), 'expired')
  assert.equal(state({ candidateId: 'c2', approvals: [approval({ expiresAt: '2026-10-29T11:00:00Z' })] }), 'pending')
})

test('expiresAt equal to now is expired', () => {
  assert.equal(state({ approvals: [approval({ expiresAt: new Date(now).toISOString() })] }), 'expired')
})

test('a new commit voids the old approval: back to pending, the old one is superseded', () => {
  const result = acceptanceState({ stage: 'publish', candidateId: 'c2', approvals: [approval()], publications: [{ approvalId: 'a1', status: 'reserved' }], now })
  assert.equal(result.state, 'pending')
  assert.equal(result.active, undefined)
  assert.equal(result.publication, undefined)
  assert.equal(result.superseded?.id, 'a1')
  // Once the current candidate has its own approval, the old one is no longer shown.
  assert.equal(acceptanceState({ stage: 'publish', candidateId: 'c2', approvals: [approval(), approval({ id: 'a2', candidateId: 'c2', createdAt: '2026-10-29T11:00:00Z' })], publications: [], now }).superseded, undefined)
  assert.equal(state({ stage: 'approval', candidateId: 'c2', approvals: [approval()] }), 'pending')
})

test('the latest approval on the current candidate wins', () => {
  assert.equal(state({ approvals: [approval(), approval({ id: 'a2', revokedAt: '2026-10-29T11:30:00Z' })] }), 'revoked')
  assert.equal(state({ approvals: [approval({ revokedAt: '2026-10-29T11:30:00Z' }), approval({ id: 'a2' })] }), 'approved')
  // After the candidate changed, approvals on the old candidate are ignored whatever their state.
  const old = [approval({ expiresAt: '2026-10-29T11:00:00Z' }), approval({ id: 'a2', revokedAt: '2026-10-29T11:30:00Z' })]
  assert.equal(state({ candidateId: 'c2', approvals: old }), 'pending')
  assert.equal(state({ candidateId: 'c2', approvals: [...old, approval({ id: 'a3', candidateId: 'c2', expiresAt: '2026-10-29T11:00:00Z' })] }), 'expired')
  assert.equal(state({ candidateId: 'c2', approvals: [...old, approval({ id: 'a3', candidateId: 'c2', revokedAt: '2026-10-29T11:40:00Z' })] }), 'revoked')
})

test('a skill is enabled rather than published', () => {
  assert.equal(acceptanceStateKey('pending', true), 'skillState.pending')
  assert.equal(acceptanceStateKey('live', true), 'skillState.live')
  assert.equal(acceptanceStateKey('checking', true), 'state.checking')
  assert.equal(acceptanceStateKey('pending', false), 'state.pending')
})

test('latest is chosen by createdAt, not by array order', () => {
  const valid = approval({ createdAt: '2026-10-29T11:00:00Z' })
  const revoked = approval({ id: 'a2', revokedAt: '2026-10-29T10:30:00Z', createdAt: '2026-10-29T10:00:00Z' })
  assert.equal(state({ approvals: [valid, revoked] }), 'approved')
  assert.equal(state({ approvals: [revoked, valid] }), 'approved')
  const newerRevoke = approval({ id: 'a3', revokedAt: '2026-10-29T11:45:00Z', createdAt: '2026-10-29T11:30:00Z' })
  assert.equal(state({ approvals: [newerRevoke, valid] }), 'revoked')
})

test('without a current candidate no approval counts', () => {
  const result = acceptanceState({ stage: 'publish', candidateId: null, approvals: [approval()], publications: [{ approvalId: 'a1', status: 'succeeded' }], now })
  assert.equal(result.state, 'unavailable')
  assert.equal(result.active, undefined)
  assert.equal(result.superseded, undefined)
  assert.equal(acceptanceState({ stage: 'approval', candidateId: null, approvals: [approval()], publications: [], now }).state, 'pending')
})
