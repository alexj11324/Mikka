// Pure, in-memory coverage; no daemon, filesystem, network or cleanup hooks.
// Kept separate from the paused integration suites for independent review.
import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonTestMode, localTestEnvironment, normalizeRepository, remoteKey, repositoryBindingMatches } from '../../protocol/src/repository.ts'

test('GitHub aliases share a v2 identity and legacy bindings are refused', () => {
  const url = 'https://github.com/Owner/Repo.git'
  const key = remoteKey(url)
  assert.equal(key, 'v2/github.com/owner/repo')
  assert.equal(remoteKey('git@github.com:owner/repo.git'), key)
  assert.equal(repositoryBindingMatches(key, url), true)
  assert.equal(repositoryBindingMatches('github.com/owner/repo', url), false)
})

test('non-GitHub endpoints retain routing distinctions', () => {
  const pairs = [
    ['https://git.example/Team/Repo.git', 'https://git.example/team/repo.git'],
    ['https://git.example/team/repo.git', 'https://git.example:8443/team/repo.git'],
    ['https://git.example/team/repo', 'https://git.example/team/repo.git'],
    ['ssh://alice@git.example/team/repo.git', 'ssh://bob@git.example/team/repo.git'],
    ['git@git.example:team/repo.git', 'ssh://git@git.example/team/repo.git'],
  ]
  for (const [a, b] of pairs) {
    assert.notEqual(remoteKey(a!), remoteKey(b!))
    assert.equal(repositoryBindingMatches(remoteKey(a!), b!), false)
  }
})

test('unsupported transports and unsafe test-mode use are rejected', () => {
  for (const input of ['/tmp/repo', 'file:///tmp/repo', 'ext::sh -c true', 'https://git.example/a/../b', 'ssh://git.example/team/repo']) {
    assert.throws(() => normalizeRepository(input))
  }
  assert.equal(daemonTestMode({ MIKKA_TEST_MODE: '1', VERCEL_ENV: 'production', CI: 'true' }), false)
  assert.equal(daemonTestMode({ MIKKA_TEST_MODE: '1', NODE_ENV: 'test' }), true)
})

test('local test mode needs MIKKA_LOCAL_TEST_ACCOUNTS=1 and only loopback *_e2e databases', () => {
  const db = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
  const local = { MIKKA_TEST_MODE: '1', MIKKA_LOCAL_TEST_ACCOUNTS: '1', NODE_ENV: 'development', MIKKA_DATABASE_URL: db, E2E_DATABASE_URL: db }
  assert.equal(daemonTestMode(local), true)
  assert.equal(daemonTestMode({ ...local, MIKKA_DATABASE_URL: 'postgresql://e2e:local@[::1]/other_e2e', E2E_DATABASE_URL: undefined }), true)
  for (const remote of ['postgresql://u:p@db.example.com:5432/mikka_e2e', 'postgresql://u:p@ep-autumn-fire.neon.tech/mikka_e2e', 'postgresql://u:p@10.0.0.5/mikka_e2e',
    'postgresql://u:p@127.0.0.1.example.com/mikka_e2e', 'postgresql://u:p@host.docker.internal/mikka_e2e', 'postgresql://u:p@127.0.0.1/orvilo_mvp', 'postgresql:///mikka_e2e', 'not a url']) {
    assert.equal(localTestEnvironment({ ...local, MIKKA_DATABASE_URL: remote }), false, remote)
    assert.equal(daemonTestMode({ ...local, MIKKA_DATABASE_URL: remote }), false, remote)
    assert.equal(daemonTestMode({ ...local, DATABASE_URL: remote }), false, remote)
  }
  for (const patch of [{ MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { MIKKA_TEST_MODE: undefined }, { MIKKA_DATABASE_URL: undefined }, { VERCEL: '1' }, { VERCEL_ENV: 'production' }])
    assert.equal(daemonTestMode({ ...local, ...patch }), false)
  // A Preview keeps its existing CI path; local mode itself never holds on a deployment.
  assert.equal(localTestEnvironment({ ...local, VERCEL_ENV: 'preview' }), false)
})
