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
