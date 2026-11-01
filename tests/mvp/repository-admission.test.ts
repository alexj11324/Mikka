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
const grant = { grantedAt: now.toISOString() }
const admitted = (overrides: Record<string, unknown> = {}) => admitRepositoryTask({ ...scope, grant: null, now, ...overrides })

test('the GitHub App grant admits; Mikka asks for no approval of its own', () => {
  assert.equal(admitted(), null, 'no grant recorded: nothing is admitted')
  for (const permissions of [null, { git_push: 'ask' }, { git_push: 'allow' }]) {
    assert.equal(effectiveRepositoryPush(permissions), 'allow', 'ask and allow do not ask the person again')
    const result = admitted({ grant, permissions })
    assert.equal(result?.authority, 'github_app')
    assert.equal(result?.approvedAt, grant.grantedAt)
  }
})

test('a workspace policy or read-only deny still wins over the grant', () => {
  for (const [permissions, workspace] of [
    [{ git_push: 'deny' }, undefined],
    [{ git_push: 'allow' }, { git_push: 'deny' }],
    [null, { git_push: 'deny' }],
  ] as const) {
    assert.equal(effectiveRepositoryPush(permissions, workspace), 'deny')
    assert.equal(admitted({ grant, permissions, workspacePermissions: workspace }), null)
  }
})

test('accepted receipt matches its original owner, issue, device, agent, repository and branch', () => {
  const requestEventId = '10000000-0000-4000-8000-000000000004'
  const workspaceId = '10000000-0000-4000-8000-000000000005'
  const result = admitted({ grant, requestEventId, workspaceId, workspaceLinked: true })
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
  assert.equal(admitted({ remoteUrl: 'https://github.com/example/other.git', grant }), null)
  assert.equal(admitted({ targetBranch: 'main', grant }), null)
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
  assert.equal(matchesRepositoryAdmission(admitted({ grant }), scope), true)
  assert.equal(matchesRepositoryAdmission({ ...legacy, approvedAt: now.toISOString(), authority: 'repository_approval' }, scope), true, 'a receipt from the earlier per-repository approval still matches')
})
