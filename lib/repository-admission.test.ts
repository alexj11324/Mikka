import assert from 'node:assert/strict'
import test from 'node:test'
import { admitRepositoryTask, matchesRepositoryAdmission } from './repository-admission'

const scope = { userId: 'owner', issueId: '10000000-0000-4000-8000-000000000001', deviceId: '30000000-0000-4000-8000-000000000003', agentId: '40000000-0000-4000-8000-000000000004', remoteKey: 'v2/github.com/owner/repo', remoteUrl: 'https://github.com/owner/repo.git', targetBranch: 'mikka/mik-1' }
const push = { approved: true, remote: 'origin', approvedByUserId: 'owner', approvedAt: '2026-10-28T10:00:00.000Z' }
const now = new Date('2026-10-28T11:00:00.000Z')

test('a human receipt admits only its exact owner and repository', () => {
  const admitted = admitRepositoryTask({ ...scope, push, now })
  assert.ok(admitted)
  assert.equal(matchesRepositoryAdmission(admitted, scope), true)
  for (const changed of [{ userId: 'other' }, { issueId: '20000000-0000-4000-8000-000000000002' }, { deviceId: '50000000-0000-4000-8000-000000000005' }, { agentId: '50000000-0000-4000-8000-000000000005' }, { remoteKey: 'v2/github.com/owner/other' }, { remoteUrl: 'https://github.com/owner/other.git' }, { targetBranch: 'mikka/mik-2' }]) {
    assert.equal(matchesRepositoryAdmission(admitted, { ...scope, ...changed }), false)
  }
  assert.equal(admitRepositoryTask({ ...scope, push: { ...push, approved: false }, now }), null)
  assert.equal(admitRepositoryTask({ ...scope, push: { ...push, approvedByUserId: 'other' }, now }), null)
  assert.equal(admitRepositoryTask({ ...scope, push, remoteUrl: 'https://github.com/owner/other.git', now }), null)
})

test('existing acceptance remains valid after revocation and cannot expand scope', () => {
  const admitted = admitRepositoryTask({ ...scope, push, now })
  assert.ok(admitted)
  assert.equal(admitRepositoryTask({ ...scope, push: { ...push, approved: false }, now }), null)
  assert.equal(matchesRepositoryAdmission(admitted, scope), true)
  assert.equal(matchesRepositoryAdmission({ ...admitted, permission: 'admin' }, scope), false)
  assert.equal(matchesRepositoryAdmission({ ...admitted, remoteKey: 'github.com/owner/repo' }, scope), false)
})
