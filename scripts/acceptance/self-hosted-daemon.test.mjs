import assert from 'node:assert/strict'
import test from 'node:test'
import { checkSessionTarget } from './self-hosted-daemon.mjs'

const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: 'a'.repeat(40),
  RUNNER_TEMP: '/tmp/runner', GITHUB_WORKSPACE: '/tmp/checkout' }
const session = { origin: 'http://localhost:3000', revision: env.GITHUB_SHA, ownerId: 'fixture-owner',
  workspaceId: 'a0000000-0000-4000-8000-000000000001', cookie: 'session=synthetic-fixture' }

test('daemon acceptance refuses external or mismatched session targets before enrollment', () => {
  assert.doesNotThrow(() => checkSessionTarget(session, env))
  for (const changes of [{ origin: 'https://app.aspectlylabs.com' }, { origin: 'http://localhost:4000' },
    { revision: 'b'.repeat(40) }, { cookie: 'session=value\r\nx-header: injected' }, { workspaceId: 'unknown' }, { ownerId: '' }]) {
    assert.throws(() => checkSessionTarget({ ...session, ...changes }, env), /SESSION_TARGET/)
  }
  for (const changes of [{ GITHUB_ACTIONS: '' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_SHA: 'main' }, { RUNNER_TEMP: '' }]) {
    assert.throws(() => checkSessionTarget(session, { ...env, ...changes }), /CI_TARGET/)
  }
})
