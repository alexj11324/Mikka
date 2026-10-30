import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRunSecretsEnvironment as resolve } from './run-environment'

test('4e3: default branch -> production, other branch -> preview, unreadable default -> preview, local -> development', () => {
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: null, repoDefaultBranch: 'main' }), { environment: 'production', rejected: false }, 'null base = remote default')
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'main', repoDefaultBranch: 'main' }), { environment: 'production', rejected: false })
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'feature/x', repoDefaultBranch: 'main' }), { environment: 'preview', rejected: false })
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'main', repoDefaultBranch: null }), { environment: 'preview', rejected: false }, 'unknown default branch is preview')
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'main', repoDefaultBranch: '  ' }), { environment: 'preview', rejected: false })
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'Main', repoDefaultBranch: 'main' }), { environment: 'preview', rejected: false }, 'branch names are case-sensitive')
  assert.deepEqual(resolve({ deviceKind: 'local', runBaseBranch: null, repoDefaultBranch: 'main', override: 'production', starterRole: 'admin' }), { environment: 'development', rejected: false }, 'local runs are always development')
})

test('4e3: only an admin-started run may override to production; a member override is rejected', () => {
  const feature = { deviceKind: 'cloud' as const, runBaseBranch: 'feature/x', repoDefaultBranch: 'main' }
  assert.deepEqual(resolve({ ...feature, override: 'production', starterRole: 'admin' }), { environment: 'production', rejected: false })
  assert.deepEqual(resolve({ ...feature, override: 'production', starterRole: 'member' }), { environment: 'preview', rejected: true })
  assert.deepEqual(resolve({ ...feature, override: 'production', starterRole: null }), { environment: 'preview', rejected: true }, 'not a member at all')
  assert.deepEqual(resolve({ ...feature, runBaseBranch: 'main', override: 'production', starterRole: 'member' }), { environment: 'production', rejected: true }, 'even when the branch would be production, the member override itself is rejected')
  assert.deepEqual(resolve({ deviceKind: 'cloud', runBaseBranch: 'main', repoDefaultBranch: 'main', override: 'preview', starterRole: 'member' }), { environment: 'preview', rejected: false }, 'anyone may lower to preview')
})
