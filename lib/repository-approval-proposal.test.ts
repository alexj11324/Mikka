import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareRepositoryApproval, validateRepositoryApproval } from './repository-approval-proposal'

test('a proposal binds the exact repository and push action without granting it', () => {
  const proposal = prepareRepositoryApproval({ repo: 'https://github.com/Team/Repo.git' })
  assert.deepEqual(proposal, { repo: 'https://github.com/Team/Repo.git', remoteKey: 'v2/github.com/team/repo', permission: 'push_to_origin' })
  assert.deepEqual(validateRepositoryApproval(proposal), proposal)
  assert.equal(prepareRepositoryApproval({ repo: 'file:///private/repo' }), null)
  assert.equal(prepareRepositoryApproval({ repo: 'team/repo', approved: true }), null)
})

test('rejects legacy, mismatched endpoint, forged permission and credential-bearing URLs', () => {
  const proposal = prepareRepositoryApproval({ repo: 'https://git.example.com:8443/Team/Repo.git' })!
  assert.equal(validateRepositoryApproval({ ...proposal, remoteKey: 'git.example.com/team/repo' }), null)
  assert.equal(validateRepositoryApproval({ ...proposal, repo: 'https://git.example.com:9443/Team/Repo.git' }), null)
  assert.equal(validateRepositoryApproval({ ...proposal, permission: 'admin' }), null)
  assert.equal(prepareRepositoryApproval({ repo: 'https://user:secret@github.com/team/repo' }), null)
})
