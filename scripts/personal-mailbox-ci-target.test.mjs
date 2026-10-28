import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPersonalMailboxCITarget } from './personal-mailbox-ci-target.mjs'
const connection = 'postgresql://e2e:synthetic-only@127.0.0.1:5432/mikka_e2e'
const env = { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '1', MIKKA_MAILBOX_DEFAULT_OFF_CI: '1', E2E_DATABASE_URL: connection, MIKKA_DATABASE_URL: connection, DATABASE_URL: connection }
test('default-off DB profile admits only the explicit existing temporary CI target', () => {
  assert.deepEqual(assertPersonalMailboxCITarget(env), { database: 'mikka_e2e', host: '127.0.0.1', port: 5432, role: 'e2e' })
  for (const patch of [{ CI: '' }, { GITHUB_ACTIONS: '' }, { GITHUB_RUN_ID: '' }, { MIKKA_MAILBOX_DEFAULT_OFF_CI: '' }, { MIKKA_PERSONAL_MAILBOX_ENABLED: '1' }, { MIKKA_NATIVE_COORDINATOR: '1' }, { VERCEL_ENV: 'preview' }, { E2E_DATABASE_URL: connection.replace('127.0.0.1', 'remote.invalid') }, { MIKKA_DATABASE_URL: 'another' }, { DATABASE_URL: 'another' }, { E2E_DATABASE_URL: connection.replace('e2e:', 'postgres:') }, { E2E_DATABASE_URL: connection + '?options=x' }, { E2E_DATABASE_URL: connection.replace('mikka_e2e', 'mikka_personal_mailbox_287') }]) {
    assert.throws(() => assertPersonalMailboxCITarget({ ...env, ...patch }), /CI_TARGET_REQUIRED/)
  }
})
