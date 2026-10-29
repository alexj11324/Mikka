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
