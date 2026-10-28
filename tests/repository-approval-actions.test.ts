import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let user: string | null = null
const decide = mock.fn(async () => ({ status: 'done' as const, error: null }))
const write = mock.fn(async () => {})
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
stub('../lib/auth.ts', { auth: { api: { getSession: async () => user ? { user: { id: user } } : null } } })
stub('../lib/session.ts', { getSession: async () => user ? { user: { id: user } } : null })
stub('../lib/pending-actions.ts', { decidePendingAction: decide })
stub('../lib/repository-approval-write.ts', { writeRepositoryPushApproval: write })
stub('../lib/github/run-pull-request.ts', { verifyGitHubRepositoryAccess: async () => ({}), PublicationError: class PublicationError extends Error {} })
stub('../lib/github/repository-installation.ts', { linkedGitHubAccountId: async () => '', saveRepositoryInstallation: async () => {} })
let pending: typeof import('../app/actions/pending-actions')
let repository: typeof import('../app/actions/repository-approval')
before(async () => { pending = await import('../app/actions/pending-actions'); repository = await import('../app/actions/repository-approval') })

test('only an authenticated human session can decide or change a repository approval', async () => {
  const id = '10000000-0000-4000-8000-000000000001'
  user = null
  assert.equal((await pending.decidePendingAction(id, true)).error, 'authRequired')
  assert.deepEqual(await repository.setRepositoryPushApproval({ repo: 'team/repo', approved: true }), { error: 'authRequired' })
  assert.equal(decide.mock.callCount(), 0)
  assert.equal(write.mock.callCount(), 0)
  user = 'human-owner'
  await pending.decidePendingAction(id, true)
  assert.deepEqual(decide.mock.calls[0].arguments, ['human-owner', id, true])
  await repository.setRepositoryPushApproval({ repo: 'team/repo', approved: false })
  assert.deepEqual(write.mock.calls[0].arguments, ['human-owner', 'v2/github.com/team/repo', false])
})
