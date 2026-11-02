import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createRunGitHubTokenExchange, type RunGitHubScope } from './run-token-exchange'
import { issueRunGitHubInstallationToken } from './run-pull-request'
import { PublicationError } from '@/lib/run-publication-result'
import { RUN_GITHUB_ERROR_CODES } from './run-token-failure'
import { RUN_GITHUB_ERROR_MESSAGES } from '../../packages/daemon/src/agents/github-credentials.mjs'

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

// Failures are logged as one structured line: category and GitHub's status only.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey }

/** A GitHub API that answers each path as the case says, echoing secrets into every body so a leak would show. */
function github(answer: (path: string) => Response | 'network') {
  return (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname
    const reply = answer(path)
    if (reply === 'network') throw new Error('connect ECONNREFUSED synthetic-network-detail')
    return reply
  }) as typeof fetch
}
const ok = (path: string) => {
  if (path === '/repos/owner/repo/installation') return Response.json({ id: 99, suspended_at: null, permissions: { pull_requests: 'write', contents: 'write' } })
  if (path.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-installation-token', expires_at: '2099-01-01T00:00:00Z' })
  if (path === '/user/123') return Response.json({ id: 123, login: 'octo' })
  if (path.endsWith('/collaborators/octo/permission')) return Response.json({ permission: 'write', user: { id: 123, login: 'octo' } })
  if (path === '/repos/owner/repo') return Response.json({ id: 789, full_name: 'owner/repo', default_branch: 'main' })
  return Response.json({ message: 'unexpected' }, { status: 500 })
}
const secretBody = (status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ message: 'synthetic-provider-body', token: 'synthetic-leaked-token' }), { status, headers })

const cases = [
  { name: 'the App is not installed on the repository', answer: (path: string) => path === '/repos/owner/repo/installation' ? secretBody(404) : ok(path), category: 'app_not_installed', githubStatus: 404, installation: 'missing', code: 'githubAppNotInstalled', status: 409 },
  { name: 'the installation is suspended', answer: (path: string) => path === '/repos/owner/repo/installation' ? Response.json({ id: 99, suspended_at: '2026-01-01T00:00:00Z', permissions: {} }) : ok(path), category: 'app_suspended', githubStatus: null, installation: 'present', code: 'githubAppSuspended', status: 409 },
  { name: 'the installation lacks pull request write', answer: (path: string) => path === '/repos/owner/repo/installation' ? Response.json({ id: 99, suspended_at: null, permissions: { pull_requests: 'read', contents: 'read' } }) : ok(path), category: 'app_permission_missing', githubStatus: null, installation: 'present', code: 'githubAppPermissionRequired', status: 409 },
  { name: 'the person cannot write to the repository', answer: (path: string) => path.endsWith('/permission') ? Response.json({ permission: 'read', user: { id: 123, login: 'octo' } }) : ok(path), category: 'account_no_write_access', githubStatus: null, installation: 'present', code: 'githubAccountNoWriteAccess', status: 409 },
  { name: 'GitHub rate limits the request', answer: (path: string) => path === '/repos/owner/repo/installation' ? secretBody(429, { 'retry-after': '60' }) : ok(path), category: 'rate_limited', githubStatus: 429, installation: 'unknown', code: 'githubRateLimited', status: 503 },
  { name: 'a rate limited 403', answer: (path: string) => path.endsWith('/access_tokens') ? secretBody(403, { 'x-ratelimit-remaining': '0' }) : ok(path), category: 'rate_limited', githubStatus: 403, installation: 'unknown', code: 'githubRateLimited', status: 503 },
  { name: 'GitHub fails with a server error', answer: (path: string) => path === '/repos/owner/repo/installation' ? secretBody(502) : ok(path), category: 'github_server_error', githubStatus: 502, installation: 'unknown', code: 'runGitHubUnavailable', status: 502 },
  { name: 'GitHub cannot be reached', answer: () => 'network' as const, category: 'github_unreachable', githubStatus: null, installation: 'unknown', code: 'runGitHubUnavailable', status: 502 },
  { name: 'GitHub rejects the App credentials', answer: (path: string) => path === '/repos/owner/repo/installation' ? secretBody(401) : ok(path), category: 'app_credentials_rejected', githubStatus: 401, installation: 'unknown', code: 'githubAppNotConfigured', status: 503 },
  { name: 'GitHub refuses the request otherwise', answer: (path: string) => path.endsWith('/access_tokens') ? secretBody(422) : ok(path), category: 'github_request_failed', githubStatus: 422, installation: 'unknown', code: 'runGitHubUnavailable', status: 502 },
]

for (const failure of cases) {
  test(`a failure is classified and logged without credentials: ${failure.name}`, async () => {
    const lines: string[] = []
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, revoke: async () => {}, log: line => { lines.push(line) },
      issue: input => issueRunGitHubInstallationToken({ ...input, env, fetcher: github(failure.answer) }) })
    const response = await handle(new Request(request(), { headers: { authorization: 'Bearer synthetic-run-token' } }))
    assert.equal(response.status, failure.status)
    assert.deepEqual(await response.json(), { error: failure.code })
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0]), { event: 'run_github_token_failed', runId: scope.runId, stage: 'issue', category: failure.category, githubStatus: failure.githubStatus, installation: failure.installation, retryable: JSON.parse(lines[0]).retryable, code: failure.code })
    for (const secret of ['synthetic', 'token"', 'Bearer', 'authorization', 'BEGIN RSA', privateKey.slice(40, 80)]) assert.ok(!lines[0].includes(secret), `log line carries ${secret}`)
  })
}

test('the App not configured on the server, a missing identity and a non-GitHub remote are named', async () => {
  for (const [input, code, category] of [
    [{ env: {} }, 'githubAppNotConfigured', 'app_not_configured'],
    [{ env, githubAccountId: '' }, 'githubIdentityRequired', 'identity_required'],
    [{ env, remoteKey: 'v2/gitlab.com/owner/repo' }, 'githubRepositoryNotSupported', 'repository_not_github'],
  ] as const) {
    const lines: string[] = []
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, revoke: async () => {}, log: line => { lines.push(line) },
      issue: base => issueRunGitHubInstallationToken({ ...base, ...input, fetcher: github(ok) }) })
    const response = await handle(request())
    assert.deepEqual(await response.json(), { error: code })
    assert.equal(JSON.parse(lines[0]).category, category)
  }
})

test('a token minted before authority failed is revoked and never logged; an unexpected error logs only its category', async () => {
  let calls = 0
  const lines: string[] = []
  const revoked: string[] = []
  const handle = createRunGitHubTokenExchange({ authorize: async () => {
    if (++calls === 2) throw new Error('synthetic-private-detail synthetic-worker-token')
    return scope
  }, issue: async () => issued, revoke: async token => { revoked.push(token) }, log: line => { lines.push(line) } })
  const response = await handle(request())
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'runGitHubUnavailable' })
  assert.deepEqual(revoked, [issued.token])
  assert.deepEqual(JSON.parse(lines[0]), { event: 'run_github_token_failed', runId: scope.runId, stage: 'reauthorize', category: 'unexpected', githubStatus: null, installation: 'unknown', retryable: true, code: 'runGitHubUnavailable' })
  assert.doesNotMatch(lines[0], /synthetic/)
})

test('every code the server returns has words the daemon can show', () => {
  for (const code of [...RUN_GITHUB_ERROR_CODES, 'runGitHubAccessDenied']) {
    const words = (RUN_GITHUB_ERROR_MESSAGES as unknown as Record<string, [string, string]>)[code]
    assert.ok(words, code)
    assert.match(words[1], /[一-龥]/, `${code} has Chinese`)
  }
  assert.ok(new PublicationError('github_unavailable', true, 429).status === 429)
})
