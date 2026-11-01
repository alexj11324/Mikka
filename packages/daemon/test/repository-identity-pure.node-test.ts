// Pure, in-memory coverage; no daemon, filesystem, network or cleanup hooks.
// Kept separate from the paused integration suites for independent review.
import assert from 'node:assert/strict'
import test from 'node:test'
import { daemonTestMode, normalizeRepository, remoteKey, repositoryBindingMatches } from '../../protocol/src/repository.ts'

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

test('local test mode enables the daemon test switch only on loopback *_e2e databases (the rule: scripts/test-accounts/local-test-mode.test.mjs)', () => {
  const db = 'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e'
  const local = { MIKKA_TEST_MODE: '1', MIKKA_LOCAL_TEST_ACCOUNTS: '1', NODE_ENV: 'development', E2E_DATABASE_URL: db, MIKKA_DATABASE_URL: db }
  assert.equal(daemonTestMode(local), true)
  for (const patch of [{ MIKKA_TEST_MODE: undefined }, { MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { MIKKA_DATABASE_URL: 'postgresql://u:p@db.example.com/mikka_e2e' }, { VERCEL: '1' }, { VERCEL_ENV: 'production' }])
    assert.equal(daemonTestMode({ ...local, ...patch }), false, JSON.stringify(patch))
})
