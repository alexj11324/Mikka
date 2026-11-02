import assert from 'node:assert/strict'
import test from 'node:test'
import { admitRepositoryTask, matchesRepositoryAdmission } from '../../lib/repository-admission'

// Pure receipt tests; transactional consumers have a separate PG gate.
const now = new Date('2026-10-28T12:00:00Z')
const scope = {
  userId: 'synthetic-owner', issueId: '10000000-0000-4000-8000-000000000001',
  deviceId: '10000000-0000-4000-8000-000000000002', agentId: '10000000-0000-4000-8000-000000000003',
  remoteKey: 'v2/github.com/example/repo', remoteUrl: 'https://github.com/example/repo.git', targetBranch: 'mikka/test-1',
}
const admitted = (overrides: Record<string, unknown> = {}) => admitRepositoryTask({ ...scope, now, ...overrides })

test('a task is admitted with no grant or approval: the run uses its owner\'s own GitHub credential', () => {
  const result = admitted()
  assert.ok(result)
  assert.equal(result.authority, 'owner_credential')
  assert.equal(result.approvedAt, undefined)
})

test('accepted receipt matches its original owner, issue, device, agent, repository and branch', () => {
  const requestEventId = '10000000-0000-4000-8000-000000000004'
  const workspaceId = '10000000-0000-4000-8000-000000000005'
  const result = admitted({ requestEventId, workspaceId, workspaceLinked: true })
  assert.ok(result)
  assert.equal(result.requestEventId, requestEventId)
  assert.equal(result.workspaceId, workspaceId)
  const acceptedScope = { ...scope, requestEventId, workspaceId }
  assert.equal(matchesRepositoryAdmission(result, { ...acceptedScope, workspaceLinked: true }), true)
  assert.equal(matchesRepositoryAdmission(result, scope), false)
  assert.equal(matchesRepositoryAdmission(result, { ...acceptedScope, workspaceLinked: true, requestEventId: 'different' }), false)
  for (const key of ['userId', 'issueId', 'deviceId', 'agentId', 'remoteKey', 'remoteUrl', 'targetBranch'] as const) {
    assert.equal(matchesRepositoryAdmission(result, { ...acceptedScope, workspaceLinked: true, [key]: 'different' }), false, key)
  }
  assert.equal(admitted({ remoteUrl: 'https://github.com/example/other.git' }), null)
  assert.equal(admitted({ targetBranch: 'main' }), null)
})

test('older receipts stay readable; configured_allow still does not match', () => {
  const old = {
    userId: scope.userId, issueId: scope.issueId, deviceId: scope.deviceId, agentId: scope.agentId, remoteKey: scope.remoteKey,
    remoteUrl: scope.remoteUrl, targetBranch: scope.targetBranch, permission: 'push_to_origin', authority: 'configured_allow', acceptedAt: now.toISOString(),
  }
  assert.equal(matchesRepositoryAdmission(old, scope), false)
  assert.equal(matchesRepositoryAdmission({ ...old, approvedAt: now.toISOString() }, scope), false)
  const { authority: _authority, ...legacy } = old
  assert.equal(matchesRepositoryAdmission(legacy, scope), true)
  for (const authority of ['github_app', 'repository_approval', 'owner_credential']) {
    assert.equal(matchesRepositoryAdmission({ ...legacy, approvedAt: now.toISOString(), authority }, scope), true, authority)
  }
})
