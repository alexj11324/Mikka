import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackDatabase, migrationGuard } from './migration-guard.mjs'

const remote = 'postgresql://owner:fixture@ep-example.us-east-2.aws.neon.tech/orvilo_mvp'
const local = 'postgresql://e2e:e2e-local-only@127.0.0.1:5432/mikka_e2e'

test('Vercel production migrates only from main', () => {
  const targets = { MIKKA_DATABASE_URL: remote, DATABASE_URL: remote }
  assert.deepEqual(migrationGuard({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' }, targets), { warning: null })
  assert.throws(() => migrationGuard({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'codex/credential-scheduler-prep-20261025' }, targets), /only from main.*credential-scheduler/)
  assert.throws(() => migrationGuard({ VERCEL_ENV: 'production' }, targets), /only from main.*<unset>/)
  // --allow-remote never overrides the production rule.
  assert.throws(() => migrationGuard({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'feature' }, targets, ['--allow-remote']), /only from main/)
})

test('outside Vercel MIGRATE=1 reaches only loopback databases unless --allow-remote', () => {
  assert.deepEqual(migrationGuard({ MIGRATE: '1' }, { MIKKA_DATABASE_URL: local, DATABASE_URL: local }), { warning: null })
  assert.throws(() => migrationGuard({ MIGRATE: '1' }, { MIKKA_DATABASE_URL: local, DATABASE_URL: remote }), /DATABASE_URL is not a loopback database/)
  const allowed = migrationGuard({ MIGRATE: '1' }, { MIKKA_DATABASE_URL: remote, DATABASE_URL: local }, ['--allow-remote'])
  assert.match(allowed.warning, /WARNING --allow-remote.*MIKKA_DATABASE_URL/)
  assert.doesNotMatch(allowed.warning, /fixture|neon\.tech/)
  // Unset targets fail later with the runner's own "is not set" error.
  assert.deepEqual(migrationGuard({ MIGRATE: '1' }, { MIKKA_DATABASE_URL: undefined, DATABASE_URL: '' }), { warning: null })
})

test('Vercel preview keeps its own preview database target', () => {
  assert.deepEqual(migrationGuard({ VERCEL: '1', VERCEL_ENV: 'preview' }, { MIKKA_DATABASE_URL: remote, DATABASE_URL: remote }), { warning: null })
})

test('loopback detection', () => {
  for (const url of [local, 'postgres://u@localhost/db', 'postgres://u@[::1]:5432/db', 'postgres://u@127.1.2.3/db', 'postgres:///db', 'postgres://u@x/db?host=/tmp'])
    assert.equal(isLoopbackDatabase(url), true, url)
  for (const url of [remote, 'postgres://u@127.0.0.1.example.com/db', 'postgres://u@db/db', 'not a url', 'mysql://u@127.0.0.1/db', 'postgres://u@127.0.0.1/db?host=db.example.com'])
    assert.equal(isLoopbackDatabase(url), false, url)
})
