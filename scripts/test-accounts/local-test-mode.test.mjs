import assert from 'node:assert/strict'
import test from 'node:test'
import { localTestDatabaseUrl, localTestMode } from '../../packages/protocol/src/local-test-mode.ts'

// The one rule for local test mode; the call sites (auth origins, signup limits,
// MVP fixture, daemon test mode, bootstrap) each test only that they use it.
const url = (host, name = 'mikka_e2e') => `postgresql://e2e:e2e-local-only@${host}:5432/${name}`
const local = url('127.0.0.1')
const mode = { MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: local, MIKKA_DATABASE_URL: local, DATABASE_URL: local }
const remotes = [url('db.example.com'), url('10.0.0.5'), url('ep-autumn-fire.neon.tech'), url('127.0.0.1.example.com'), url('host.docker.internal'),
  url('127.0.0.1', 'orvilo_mvp'), url('127.0.0.1', 'mikka'), `${local}?options=-csearch_path=business`, 'postgresql:///mikka_e2e', 'mysql://e2e@127.0.0.1/mikka_e2e', 'not a url']

test('a local test database is a loopback PostgreSQL whose name ends in _e2e', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(localTestDatabaseUrl(url(host)), true, host)
  assert.equal(localTestDatabaseUrl('postgres://e2e@localhost/other_e2e'), true)
  for (const remote of remotes) assert.equal(localTestDatabaseUrl(remote), false, remote)
})

test('local test mode needs its switch, no Vercel deployment, E2E_DATABASE_URL and only local databases', () => {
  assert.equal(localTestMode(mode), true)
  assert.equal(localTestMode({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: local }), true)
  for (const patch of [
    { MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { MIKKA_LOCAL_TEST_ACCOUNTS: 'true' }, { E2E_DATABASE_URL: undefined },
    { VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' },
  ]) assert.equal(localTestMode({ ...mode, ...patch }), false, JSON.stringify(patch))
  for (const name of ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL'])
    for (const remote of remotes) assert.equal(localTestMode({ ...mode, [name]: remote }), false, `${name}=${remote}`)
})
