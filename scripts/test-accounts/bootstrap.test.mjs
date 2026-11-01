import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { localDatabaseTarget } from './bootstrap.mjs'

const url = (host, name = 'mikka_e2e') => `postgresql://e2e:e2e-local-only@${host}:5432/${name}`

test('local mode binds only a loopback *_e2e database', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(localDatabaseTarget(url(host)).name, 'mikka_e2e')
  for (const remote of [url('db.example.com'), url('10.0.0.5'), url('ep-autumn-fire.neon.tech'), url('127.0.0.1.example.com'), url('host.docker.internal')])
    assert.throws(() => localDatabaseTarget(remote), { code: 'LOCAL_DATABASE_REQUIRED' })
  assert.throws(() => localDatabaseTarget(url('127.0.0.1', 'orvilo_mvp')), { code: 'LOCAL_DATABASE_REQUIRED' })
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
