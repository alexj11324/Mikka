import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { PublicationError } from '@/lib/run-publication-result'
import { createRunGitHubTokenExchange, type RunGitHubScope } from './run-token-exchange'

const scope: RunGitHubScope = { runId: 'run-one', userId: 'owner', remoteKey: 'v2/github.com/owner/repo', branch: 'mikka/mik-1', githubAccountId: '123' }
const issued = { token: 'synthetic-worker-token', expiresAt: '2099-01-01T00:00:00Z' }
const request = () => new Request('https://mikka.example/api/runs/github-token', { method: 'POST' })

test('only the server-derived repository is issued and responses are never cached', async () => {
  const handle = createRunGitHubTokenExchange({ authorize: async () => scope, issue: async input => {
    assert.deepEqual(input, { remoteKey: scope.remoteKey, githubAccountId: scope.githubAccountId })
    return issued
  }, revoke: async () => assert.fail('valid token revoked') })
  const result = await handle(new Request(request(), { method: 'POST', body: JSON.stringify({ repository: 'other/repo' }) }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await result.json(), { ...issued, repository: 'owner/repo', branch: scope.branch })
})

test('ended, stopped, unowned or expired runs cannot issue a token', async () => {
  const handle = createRunGitHubTokenExchange({ authorize: async () => null, issue: async () => assert.fail('unauthorized issuance'), revoke: async () => {} })
  assert.equal((await handle(request())).status, 403)
})

for (const change of [null, { ...scope, remoteKey: 'v2/github.com/other/repo' }, { ...scope, branch: 'mikka/mik-2' }, { ...scope, githubAccountId: '456' }]) {
  test(`authority changed during issuance: ${change?.remoteKey ?? 'stopped'} ${change?.branch ?? ''} ${change?.githubAccountId ?? ''}`, async () => {
    let calls = 0
    const revoked: string[] = []
    const handle = createRunGitHubTokenExchange({ authorize: async () => ++calls === 1 ? scope : change,
      issue: async () => issued, revoke: async token => { revoked.push(token) } })
    const result = await handle(request())
    assert.equal(result.status, 403)
    assert.deepEqual(revoked, [issued.token])
    assert.doesNotMatch(await result.text(), /synthetic-worker-token/)
  })
}

test('provider exceptions and failed final authorization do not disclose credentials', async () => {
  let calls = 0
  let revoked = false
  const handle = createRunGitHubTokenExchange({ authorize: async () => {
    if (++calls === 2) throw new Error('synthetic-private-detail')
    return scope
  }, issue: async () => issued, revoke: async () => { revoked = true } })
  const response = await handle(request())
  assert.equal(response.status, 502)
  assert.equal(revoked, true)
  assert.doesNotMatch(await response.text(), /synthetic/)
})

test('a failed issuance logs and reports its safe code, nothing from GitHub', async () => {
  const log = mock.method(console, 'error', () => {})
  try {
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, issue: async () => { throw new PublicationError('github_permission_required') }, revoke: async () => {} })
    const response = await handle(request())
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: 'runGitHubUnavailable', reason: 'github_permission_required' })
    assert.deepEqual(log.mock.calls[0].arguments, ['Run GitHub token failed', { runId: 'run-one', code: 'github_permission_required' }])
  } finally { log.mock.restore() }
})

test('an unexpected exception is reported without its message', async () => {
  const log = mock.method(console, 'error', () => {})
  try {
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, issue: async () => { throw new Error('synthetic-private-detail') }, revoke: async () => {} })
    const body = await (await handle(request())).text()
    assert.doesNotMatch(body, /synthetic/)
    assert.doesNotMatch(JSON.stringify(log.mock.calls[0].arguments), /synthetic/)
  } finally { log.mock.restore() }
})
