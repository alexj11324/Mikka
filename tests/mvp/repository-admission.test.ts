import assert from 'node:assert/strict'
import test from 'node:test'
import { admitRepositoryTask, effectiveRepositoryPush, matchesRepositoryAdmission } from '../../lib/repository-admission'

// Pure policy/receipt tests; transactional consumers have a separate PG gate.
const now = new Date('2026-10-28T12:00:00Z')
const scope = {
  userId: 'synthetic-owner', issueId: '10000000-0000-4000-8000-000000000001',
  deviceId: '10000000-0000-4000-8000-000000000002', agentId: '10000000-0000-4000-8000-000000000003',
  remoteKey: 'v2/github.com/example/repo', remoteUrl: 'https://github.com/example/repo.git', targetBranch: 'mikka/test-1',
}
const approval = { approved: true, remote: 'origin', approvedByUserId: scope.userId, approvedAt: now.toISOString() }
const admitted = (overrides: Record<string, unknown> = {}) => admitRepositoryTask({ ...scope, push: null, now, ...overrides })

test('allow, ask and deny resolve before an admission is issued', () => {
  assert.equal(effectiveRepositoryPush(null, null, scope.userId), 'ask')
  assert.equal(admitted(), null)
  // git_push: allow never stands in for the repository approval.
  assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, null, scope.userId), 'ask')
  assert.equal(admitted({ permissions: { git_push: 'allow' } }), null)
  assert.equal(effectiveRepositoryPush(null, approval, scope.userId), 'allow')
  assert.equal(admitted({ push: approval })?.authority, 'repository_approval')
  assert.equal(effectiveRepositoryPush({ git_push: 'deny' }, approval, scope.userId), 'deny')
  assert.equal(admitted({ push: approval, permissions: { git_push: 'deny' } }), null)
  assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, approval, scope.userId, { git_push: 'deny' }), 'deny')
  assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, { approved: false }, scope.userId), 'deny')
  assert.equal(effectiveRepositoryPush(null, { approved: false }, scope.userId), 'deny')
  assert.equal(effectiveRepositoryPush(null, { ...approval, approvedByUserId: 'other' }, scope.userId), 'ask')
})

test('accepted receipt matches its original owner, issue, device, agent, repository and branch', () => {
  const requestEventId = '10000000-0000-4000-8000-000000000004'
  const workspaceId = '10000000-0000-4000-8000-000000000005'
  const result = admitted({ push: approval, requestEventId, workspaceId, workspaceLinked: true })
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
  assert.equal(admitted({ remoteUrl: 'https://github.com/example/other.git', push: approval }), null)
  assert.equal(admitted({ targetBranch: 'main', push: approval }), null)
  // A later revocation changes a new decision, not the immutable old receipt.
  assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, { approved: false }, scope.userId), 'deny')
  assert.equal(matchesRepositoryAdmission(result, { ...acceptedScope, workspaceLinked: true }), true)
})

test('both gates are required: repository approval and git_push', () => {
  // allow without a repository approval: not admitted.
  for (const push of [null, undefined, { ...approval, approvedByUserId: 'other' }, { ...approval, approvedAt: undefined }, { ...approval, remote: 'upstream' }]) {
    assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, push, scope.userId), 'ask')
    assert.equal(admitted({ push, permissions: { git_push: 'allow' } }), null)
  }
  // allow with the approval: admitted on the owner's approval receipt.
  const allowed = admitted({ push: approval, permissions: { git_push: 'allow' } })
  assert.equal(effectiveRepositoryPush({ git_push: 'allow' }, approval, scope.userId), 'allow')
  assert.equal(allowed?.authority, 'repository_approval')
  assert.equal(allowed?.approvedAt, approval.approvedAt)
  // ask with the approval: admitted on the same receipt.
  const asked = admitted({ push: approval, permissions: { git_push: 'ask' } })
  assert.equal(effectiveRepositoryPush({ git_push: 'ask' }, approval, scope.userId), 'allow')
  assert.equal(asked?.authority, 'repository_approval')
  assert.equal(asked?.approvedAt, approval.approvedAt)
  // deny on either gate denies.
  for (const [permissions, push, workspace] of [
    [{ git_push: 'deny' }, approval, undefined],
    [{ git_push: 'allow' }, approval, { git_push: 'deny' }],
    [{ git_push: 'allow' }, { approved: false }, undefined],
    [{ git_push: 'ask' }, { approved: false }, undefined],
    [null, approval, { git_push: 'deny' }],
  ] as const) {
    assert.equal(effectiveRepositoryPush(permissions, push, scope.userId, workspace), 'deny')
    assert.equal(admitted({ push, permissions, workspacePermissions: workspace }), null)
  }
})

test('an old configured_allow receipt without an approval no longer matches', () => {
  const old = {
    userId: scope.userId, issueId: scope.issueId, deviceId: scope.deviceId, agentId: scope.agentId, remoteKey: scope.remoteKey,
    remoteUrl: scope.remoteUrl, targetBranch: scope.targetBranch, permission: 'push_to_origin', authority: 'configured_allow', acceptedAt: now.toISOString(),
  }
  assert.equal(matchesRepositoryAdmission(old, scope), false)
  assert.equal(matchesRepositoryAdmission({ ...old, approvedAt: now.toISOString() }, scope), false, 'configured_allow never grants, even with a timestamp')
  const { authority: _authority, ...legacy } = old
  assert.equal(matchesRepositoryAdmission(legacy, scope), false, 'a receipt without an approval time grants nothing')
  assert.equal(matchesRepositoryAdmission({ ...legacy, approvedAt: now.toISOString() }, scope), true, 'an older approval receipt without the authority field still matches')
  assert.equal(matchesRepositoryAdmission(admitted({ push: approval }), scope), true)
})
