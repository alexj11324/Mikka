import assert from 'node:assert/strict'
import test from 'node:test'
import { createRunGitHubTokenExchange, type RunGitHubScope } from './run-token-exchange'
import { GitHubAccessError } from './user-access-error'
import { RUN_GITHUB_ERROR_CODES } from './run-token-failure'
import { RUN_GITHUB_ERROR_MESSAGES } from '../../packages/daemon/src/agents/github-credentials.mjs'

const scope: RunGitHubScope = { runId: 'run-one', userId: 'owner' }
const now = Date.parse('2026-11-02T00:00:00Z')
const request = () => new Request('https://mikka.example/api/runs/github-token', { method: 'POST' })

test('the owner\'s own token is issued with no repository scope; the request body names nothing; responses are never cached', async () => {
  const handle = createRunGitHubTokenExchange({ authorize: async () => scope, now: () => now, issue: async userId => {
    assert.equal(userId, 'owner')
    return { token: 'synthetic-user-token', expiresAt: new Date(now + 8 * 60 * 60_000) }
  } })
  const result = await handle(new Request(request(), { method: 'POST', body: JSON.stringify({ repository: 'other/repo', userId: 'peer' }) }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await result.json(), { token: 'synthetic-user-token', expiresAt: '2026-11-02T01:00:00.000Z' }, 'a worker asks again within the hour')
})

test('a token GitHub expires sooner keeps its own expiry', async () => {
  const expiresAt = new Date(now + 50 * 60_000)
  const handle = createRunGitHubTokenExchange({ authorize: async () => scope, now: () => now, issue: async () => ({ token: 'synthetic-user-token', expiresAt }) })
  assert.equal((await (await handle(request())).json()).expiresAt, expiresAt.toISOString())
})

test('a direct task machine refreshes only at the provider expiry, including non-expiring tokens', async () => {
  for (const expiresAt of [null, new Date(now + 8 * 60 * 60_000)]) {
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, naturalExpiry: true, now: () => now,
      issue: async () => ({ token: 'synthetic-user-token', expiresAt }) })
    const result = await handle(request())
    assert.equal(result.status, 200)
    assert.deepEqual(await result.json(), { token: 'synthetic-user-token', expiresAt: expiresAt?.toISOString() ?? null })
  }
})

test('bookkeeping after issuance sees the scope and the token, and its failure never withholds the token', async () => {
  const seen: unknown[] = []
  for (const fail of [false, true]) {
    const handle = createRunGitHubTokenExchange({ authorize: async () => ({ ...scope, remoteKey: 'v2/github.com/o/r' }), now: () => now,
      issue: async () => ({ token: 'synthetic-user-token', expiresAt: null, githubAccountId: '7' }),
      afterIssue: async (current, issued) => { seen.push([current.remoteKey, issued.githubAccountId]); if (fail) throw new Error('synthetic bookkeeping failure') } })
    const response = await handle(request())
    assert.equal(response.status, 200)
    assert.equal((await response.json()).token, 'synthetic-user-token')
  }
  assert.deepEqual(seen, [['v2/github.com/o/r', '7'], ['v2/github.com/o/r', '7']])
})

test('ended, stopped, unowned or expired runs cannot get a token', async () => {
  const handle = createRunGitHubTokenExchange({ authorize: async () => null, issue: async () => assert.fail('unauthorized issuance') })
  assert.equal((await handle(request())).status, 403)
})

for (const change of [null, { ...scope, runId: 'run-two' }, { ...scope, userId: 'peer' }]) {
  test(`authority changed during issuance withholds the token: ${change ? JSON.stringify(change) : 'stopped'}`, async () => {
    let calls = 0
    const handle = createRunGitHubTokenExchange({ authorize: async () => ++calls === 1 ? scope : change, issue: async () => ({ token: 'synthetic-user-token', expiresAt: null }) })
    const result = await handle(request())
    assert.equal(result.status, 403)
    assert.doesNotMatch(await result.text(), /synthetic-user-token/)
  })
}

test('failures return and log only a code, never a provider detail or token', async () => {
  const cases: [unknown, string, number][] = [
    [new GitHubAccessError('githubNotConnected', 409), 'githubNotConnected', 409],
    [new GitHubAccessError('githubReconnectRequired', 401), 'githubReconnectRequired', 409],
    [new GitHubAccessError('githubRepositoryForbidden', 403), 'githubReconnectRequired', 409],
    [new GitHubAccessError('githubUnavailable', 502), 'runGitHubUnavailable', 502],
    [new Error('synthetic-private-detail synthetic-user-token'), 'runGitHubUnavailable', 502],
  ]
  for (const [error, code, status] of cases) {
    const lines: string[] = []
    const handle = createRunGitHubTokenExchange({ authorize: async () => scope, issue: async () => { throw error }, log: line => lines.push(line) })
    const response = await handle(request())
    assert.equal(response.status, status)
    const body = await response.text()
    assert.deepEqual(JSON.parse(body), { error: code })
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0]), { event: 'run_github_token_failed', runId: 'run-one', stage: 'issue', code, retryable: status === 502 })
    assert.doesNotMatch(body + lines.join(''), /synthetic/)
  }
})

test('every code the server returns has words the daemon can show', () => {
  for (const code of [...RUN_GITHUB_ERROR_CODES, 'runGitHubAccessDenied']) {
    const words = (RUN_GITHUB_ERROR_MESSAGES as Record<string, readonly string[]>)[code]
    assert.ok(words, code)
    assert.equal(words.length, 2)
  }
})

// Daemons released before #1023 (up to 0.0.315) refuse an answer that does not name
// the run's repository; their clone then fails with "could not read Username"
// (production, 2026-11-02 21:08Z, daemon 0.0.310). The released helper must still work.
for (const [label, load] of [
  ['daemon 0.0.310 (released)', () => import('./fixtures/github-credentials-0.0.310.mjs')],
  ['current daemon', () => import('../../packages/daemon/src/agents/github-credentials.mjs')],
] as const) {
  test(`${label}: its git credential helper gets the owner's token from today's answer`, async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const helper = await load() as { getRunGitHubToken(config: Record<string, string>, options: { fetcher: typeof fetch; now: () => number }): Promise<string> }
    const handle = createRunGitHubTokenExchange({
      authorize: async () => ({ ...scope, remoteKey: 'v2/github.com/alexj11324/mikka_test' }), now: () => now,
      issue: async () => ({ token: 'synthetic-user-token', expiresAt: new Date(now + 8 * 60 * 60_000) }),
    })
    const directory = await mkdtemp(join(tmpdir(), 'run-github-'))
    try {
      // The claim's github.repository is the remote key without its v2/github.com/ prefix.
      const config = { file: join(directory, 'config.json'), endpoint: 'https://mikka.example/api/runs/github-token', runToken: 'synthetic-run-token', repository: 'alexj11324/mikka_test' }
      await writeFile(config.file, JSON.stringify(config), { mode: 0o600 })
      const fetcher = (async (url: string, init: RequestInit) => handle(new Request(url, init))) as typeof fetch
      assert.equal(await helper.getRunGitHubToken(config, { fetcher, now: () => now }), 'synthetic-user-token')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

test('the answer names the run\'s repository only when the run has a github.com one', async () => {
  const issue = async () => ({ token: 'synthetic-user-token', expiresAt: null })
  const withRepo = createRunGitHubTokenExchange({ authorize: async () => ({ ...scope, remoteKey: 'v2/github.com/o/r' }), now: () => now, issue })
  assert.equal((await (await withRepo(request())).json() as { repository?: string }).repository, 'o/r')
  const without = createRunGitHubTokenExchange({ authorize: async () => scope, now: () => now, issue })
  assert.equal('repository' in (await (await without(request())).json() as object), false)
})
