import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertFixtureBuild, assertFixtureRuntime, fixtureDatabase } from './guard.mjs'

const env = { DATABASE_URL: 'postgresql://fixture:local@127.0.0.1:5432/ui_e2e' }
const local = { preset: 'node-server', target: 'local-fixture' }

test('fixture auth refuses a release build even when NODE_ENV is development', () => {
  for (const built of [{ preset: 'node-server' }, { preset: 'node-server', target: 'production' }, { ...local, preset: 'vercel' }])
    assert.throws(() => assertFixtureRuntime({ env: { ...env, NODE_ENV: 'development' }, built, origin: 'http://127.0.0.1:3000' }), /FIXTURE_RELEASE_BUILD_FORBIDDEN/)
  assert.equal(assertFixtureRuntime({ env: { ...env, NODE_ENV: 'production' }, built: local, origin: 'http://127.0.0.1:3000' }).database.pathname, '/ui_e2e')
})

test('fixture seeds refuse remote, non-disposable, mixed databases and deployed builds before any write', () => {
  for (const url of ['postgres://fixture@db.example.test/ui_e2e', 'postgres://fixture@127.0.0.1/production',
    'postgres://fixture@127.0.0.1/ui_e2e?host=db.example.test', 'postgres://fixture@127.0.0.1/%75i_e2e'])
    assert.throws(() => fixtureDatabase({ DATABASE_URL: url }), /FIXTURE_DATABASE_NOT_DISPOSABLE/)
  assert.throws(() => fixtureDatabase({ ...env, MIKKA_DATABASE_URL: 'postgres://fixture@localhost/other_e2e' }), /FIXTURE_DATABASES_MUST_MATCH/)
  for (const remote of [{ VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { NITRO_PRESET: 'vercel' }, { MIKKA_DEPLOYMENT_STAGE: 'production' }])
    assert.throws(() => assertFixtureBuild(remote), /FIXTURE_DEPLOYMENT_FORBIDDEN/)
  assert.throws(() => assertFixtureRuntime({ env, built: local, origin: 'http://0.0.0.0:3000' }), /FIXTURE_ORIGIN_NOT_LOOPBACK/)
})
