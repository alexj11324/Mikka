import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrationGate } from './migrate-gate.mjs'

test('Vercel production build still migrates (env Vercel sets on production builds)', () => {
  assert.equal(migrationGate({ VERCEL: '1', VERCEL_ENV: 'production', CI: '1' }).run, true)
})
test('Vercel preview and development builds skip, as before', () => {
  assert.equal(migrationGate({ VERCEL: '1', VERCEL_ENV: 'preview' }).run, false)
  assert.equal(migrationGate({ VERCEL: '1', VERCEL_ENV: 'development' }).run, false)
})
test('local build skips by default', () => {
  assert.equal(migrationGate({}).run, false)
  assert.equal(migrationGate({ MIKKA_DATABASE_URL: 'postgres://x', DATABASE_URL: 'postgres://y' }).run, false)
})
test('local env pulled from Vercel (VERCEL_ENV=production without VERCEL=1) skips', () => {
  assert.equal(migrationGate({ VERCEL_ENV: 'production' }).run, false)
})
test('explicit opt-in runs', () => {
  assert.equal(migrationGate({ MIKKA_RUN_MIGRATIONS: '1' }).run, true)
  assert.equal(migrationGate({ MIGRATE: '1' }).run, true)
  assert.equal(migrationGate({ MIKKA_RUN_MIGRATIONS: 'true' }).run, false)
  assert.equal(migrationGate({ MIKKA_RUN_MIGRATIONS: '0' }).run, false)
})

test('production ignores MIGRATE=0 / MIKKA_RUN_MIGRATIONS=0 with a warning', () => {
  for (const name of ['MIGRATE', 'MIKKA_RUN_MIGRATIONS']) {
    const gate = migrationGate({ VERCEL: '1', VERCEL_ENV: 'production', [name]: '0' })
    assert.equal(gate.run, true)
    assert.equal(gate.warnings.length, 1)
    assert.match(gate.warnings[0], new RegExp(`^${name}=0 is ignored`))
  }
  assert.equal(migrationGate({ VERCEL: '1', VERCEL_ENV: 'production', MIGRATE: '0', MIKKA_RUN_MIGRATIONS: '0' }).warnings.length, 2)
  assert.deepEqual(migrationGate({ VERCEL: '1', VERCEL_ENV: 'production' }).warnings, [])
})
test('=0 outside production skips without a warning', () => {
  const gate = migrationGate({ MIKKA_RUN_MIGRATIONS: '0', VERCEL_ENV: 'production' })
  assert.equal(gate.run, false)
  assert.deepEqual(gate.warnings, [])
})
test('skip reason shows actual flag values but never connection strings', () => {
  const gate = migrationGate({ MIKKA_RUN_MIGRATIONS: 'true', VERCEL: '1', VERCEL_ENV: 'preview', MIKKA_DATABASE_URL: 'postgres://u:secretpw@h/db', DATABASE_URL: 'postgres://u:secretpw2@h/db' })
  assert.equal(gate.run, false)
  assert.match(gate.reason, /MIKKA_RUN_MIGRATIONS="true"/)
  assert.match(gate.reason, /MIGRATE=\(unset\)/)
  assert.match(gate.reason, /VERCEL="1"/)
  assert.match(gate.reason, /VERCEL_ENV="preview"/)
  assert.doesNotMatch(gate.reason, /postgres|secretpw|DATABASE_URL/)
})
