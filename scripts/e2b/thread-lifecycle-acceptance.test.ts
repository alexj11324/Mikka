import assert from 'node:assert/strict'
import test from 'node:test'
import { validateThreadLifecycleTarget } from './thread-lifecycle-acceptance'

const isolated = () => ({ NODE_ENV: 'test', MIKKA_LOCAL_TEST_ACCOUNTS: '1',
  E2E_DATABASE_URL: 'postgresql://test:synthetic@127.0.0.1:5432/mikka_e2e', E2B_API_KEY: 'synthetic-only' })

test('provider acceptance admits the guarded disposable target and official template without returning its key', () => {
  const config = validateThreadLifecycleTarget(isolated())
  assert.equal(config.template, 'codex')
  assert.equal(config.database.hostname, '127.0.0.1')
  assert.ok(!JSON.stringify(config).includes('synthetic-only'))
})

test('provider acceptance rejects deployment, remote DB, URL override, mixed DB and unapproved template before allocation', () => {
  for (const patch of [
    { VERCEL: '1' }, { NODE_ENV: 'production' }, { WORKFLOW_TARGET_WORLD: 'production' },
    { E2E_DATABASE_URL: 'postgresql://test:synthetic@example.invalid/mikka_e2e' },
    { E2E_DATABASE_URL: isolated().E2E_DATABASE_URL + '?host=example.invalid' },
    { DATABASE_URL: 'postgresql://test:synthetic@example.invalid/production' },
    { E2B_CODEX_TEMPLATE: 'unreviewed-template' },
  ]) assert.throws(() => validateThreadLifecycleTarget({ ...isolated(), ...patch }))
})

test('only nonallocating preflight can omit the process credential', () => {
  const env: Record<string, string | undefined> = isolated(); delete env.E2B_API_KEY
  assert.throws(() => validateThreadLifecycleTarget(env))
  assert.equal(validateThreadLifecycleTarget(env, true).template, 'codex')
  assert.throws(() => validateThreadLifecycleTarget({ ...env, E2B_API_KEY: 'invalid\ncredential' }))
})
