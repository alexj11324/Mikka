import assert from 'node:assert/strict'
import test from 'node:test'
import { runTestFixture } from './run-test-fixture'

const database = 'postgresql://test:disposable@127.0.0.1:5432/mikka_e2e'
const isolated = { MIKKA_TEST_MODE: '1', MIKKA_MVP_E2E: '1', CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'production', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database }

test('the real production build can assign a recording only in the isolated CI fixture', () => {
  assert.equal(runTestFixture('mock', isolated), 'mvp-core-loop')
  for (const harness of ['claude_code', 'codex', 'cursor']) assert.equal(runTestFixture(harness, isolated), undefined)
})

test('a test-mode flag alone cannot enable the browser fixture on a deployment or business database', () => {
  for (const patch of [
    { MIKKA_TEST_MODE: undefined }, { MIKKA_MVP_E2E: undefined }, { CI: undefined }, { GITHUB_ACTIONS: undefined },
    { VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { MIKKA_NATIVE_COORDINATOR: '1' },
    { DATABASE_URL: 'postgresql://localhost/business' }, { MIKKA_DATABASE_URL: undefined },
    { E2E_DATABASE_URL: `${database}?options=-csearch_path=business` },
  ]) assert.equal(runTestFixture('mock', { ...isolated, ...patch }), undefined)
})

test('local test mode stands in for the CI job only on the loopback mikka_e2e database (the rule: scripts/test-accounts/local-test-mode.test.mjs)', () => {
  const local = { ...isolated, CI: undefined, GITHUB_ACTIONS: undefined, MIKKA_LOCAL_TEST_ACCOUNTS: '1' }
  assert.equal(runTestFixture('mock', local), 'mvp-core-loop')
  const remote = 'postgresql://u:p@db.example.com:5432/mikka_e2e'
  for (const patch of [{ MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { VERCEL_ENV: 'preview' }, { MIKKA_DATABASE_URL: remote }, { E2E_DATABASE_URL: remote, MIKKA_DATABASE_URL: remote, DATABASE_URL: remote }])
    assert.equal(runTestFixture('mock', { ...local, ...patch }), undefined)
})
