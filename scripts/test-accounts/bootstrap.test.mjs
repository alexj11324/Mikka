import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { localDatabaseTarget } from './bootstrap.mjs'

const url = (host, name = 'mikka_e2e') => `postgresql://e2e:e2e-local-only@${host}:5432/${name}`

test('local mode binds only a loopback *_e2e database (the rule: local-test-mode.test.mjs)', () => {
  assert.equal(localDatabaseTarget(url('127.0.0.1')).name, 'mikka_e2e')
  assert.throws(() => localDatabaseTarget(url('db.example.com')), { code: 'LOCAL_DATABASE_REQUIRED' })
  // The harness also needs credentials it can bind, which the rule does not check.
  assert.throws(() => localDatabaseTarget('postgresql:///mikka_e2e'), { code: 'DATABASE_URL_INVALID' })
})

test('the local CLI refuses a non-local database before connecting or writing anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikka-local-bootstrap-'))
  const output = join(dir, 'environment.json')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const remote = url('db.example.com')
  const result = spawnSync(process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', output], {
    encoding: 'utf8', timeout: 20_000,
    // No CI variable is set: local mode must not need or read one.
    env: { PATH: process.env.PATH, MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: remote, MIKKA_DATABASE_URL: remote, DATABASE_URL: remote,
      BETTER_AUTH_URL: 'http://localhost:3100', MIKKA_TEST_DEPLOYMENT_SHA: sha, BETTER_AUTH_SECRET: 'x'.repeat(64) },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Test environment bootstrap blocked/)
  assert.equal(existsSync(output), false)
})

test('without the local switch the CI guard is unchanged', () => {
  const result = spawnSync(process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', join(tmpdir(), 'unused.json')], {
    encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, E2E_DATABASE_URL: url('127.0.0.1') },
  })
  assert.equal(result.status, 1)
})
