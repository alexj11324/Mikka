import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptanceState, acceptanceStateKey } from './acceptance-state'

const now = Date.parse('2026-10-29T12:00:00Z')
const approval = (patch: Record<string, unknown> = {}) => ({ id: 'a1', candidateId: 'c1', expiresAt: '2026-10-29T13:00:00Z', revokedAt: null, ...patch })
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
  assert.equal(state({ candidateId: 'c2', approvals: [approval({ expiresAt: '2026-10-29T11:00:00Z' })] }), 'invalidated')
})

test('a skill is enabled rather than published', () => {
  assert.equal(acceptanceStateKey('pending', true), 'skillState.pending')
  assert.equal(acceptanceStateKey('live', true), 'skillState.live')
  assert.equal(acceptanceStateKey('checking', true), 'state.checking')
  assert.equal(acceptanceStateKey('pending', false), 'state.pending')
})
