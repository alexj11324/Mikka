import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrationTargets } from './migration-targets.mjs'

test('Preview migration routes both targets to its configured branch, never the global application URL', () => {
  const env = { VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://preview_user@preview.example:5432/previewdb?sslmode=require', MIKKA_DATABASE_URL: 'postgres://production' }
  assert.deepEqual(migrationTargets(env), { MIKKA_DATABASE_URL: env.DATABASE_URL, DATABASE_URL: env.DATABASE_URL })
  for (const value of [undefined, '', '  ']) assert.throws(() => migrationTargets({ ...env, DATABASE_URL: value }), /PREVIEW_DATABASE_URL_REQUIRED/)
  assert.equal(migrationTargets({ ...env, DATABASE_URL: 'postgres://user@preview/db', PGPORT: '6432' }).MIKKA_DATABASE_URL, 'postgres://user@preview:5432/db')
  assert.throws(() => migrationTargets({ ...env, DATABASE_URL: 'postgres://user@preview/db', PGPASSWORD: 'fixture-secret' }), /PREVIEW_DATABASE_URL_INVALID/)
  for (const value of ['postgres://', 'https://user@preview/db', 'postgres://preview/db', 'postgres://user@preview/', 'postgres://user@preview/db?host=prod', ' postgres://user@preview/db']) assert.throws(() => migrationTargets({ ...env, DATABASE_URL: value, PGHOST: 'production' }), /PREVIEW_DATABASE_URL_INVALID/)
})

test('production and local migration targets retain their separate configured URLs', () => {
  const env = { DATABASE_URL: 'postgres://workspace', MIKKA_DATABASE_URL: 'postgres://mikka' }
  for (const mode of ['production', 'development', undefined]) {
    assert.deepEqual(migrationTargets({ ...env, VERCEL_ENV: mode }), env)
  }
})
