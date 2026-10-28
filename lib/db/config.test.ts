import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mikkaDatabaseURL, workspaceDatabaseURL } from './config'

const urls = { DATABASE_URL: 'postgres://preview_user:fixture@preview.example:5432/previewdb?sslmode=require', MIKKA_DATABASE_URL: 'postgres://mikka' }

test('Preview uses the Neon integration branch rather than global database overrides', () => {
  assert.equal(mikkaDatabaseURL({ ...urls, VERCEL_ENV: 'preview' }), urls.DATABASE_URL)
  for (const missing of [undefined, '', '   ']) {
    const env = { ...urls, DATABASE_URL: missing, VERCEL_ENV: 'preview' }
    assert.throws(() => mikkaDatabaseURL(env), /PREVIEW_DATABASE_URL_REQUIRED/)
    assert.throws(() => workspaceDatabaseURL(env), /PREVIEW_DATABASE_URL_REQUIRED/)
  }
  assert.equal(workspaceDatabaseURL({ ...urls, VERCEL_ENV: 'preview' }), urls.DATABASE_URL)
  assert.equal(mikkaDatabaseURL({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user:fixture@preview/db?sslmode=require', PGPORT: '6432' }), 'postgres://user:fixture@preview:5432/db?sslmode=require')
  assert.equal(mikkaDatabaseURL({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgresql://user:fixture@[::1]:6432/db?sslmode=require&channel_binding=require' }), 'postgresql://user:fixture@[::1]:6432/db?sslmode=require&channel_binding=require')
  assert.throws(() => mikkaDatabaseURL({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user@preview/db', PGPASSWORD: 'fixture-secret' }), /PREVIEW_DATABASE_URL_INVALID/)
  assert.throws(() => mikkaDatabaseURL({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user@preview/db' }), /PREVIEW_DATABASE_URL_INVALID/)
  assert.equal(mikkaDatabaseURL({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user:fixture@preview/db', PGPASSWORD: 'other-fixture' }), 'postgres://user:fixture@preview:5432/db')
  for (const invalid of ['postgres://', 'https://user:fixture@preview/db', 'postgres://preview/db', 'postgres://user:fixture@preview/', 'postgres://user:fixture@preview/db?host=prod', ' postgres://user:fixture@preview/db']) {
    const env = { ...urls, DATABASE_URL: invalid, VERCEL_ENV: 'preview', PGHOST: 'production' }
    assert.throws(() => mikkaDatabaseURL(env), /PREVIEW_DATABASE_URL_INVALID/)
    assert.throws(() => workspaceDatabaseURL(env), /PREVIEW_DATABASE_URL_INVALID/)
  }
})

test('other deployments use MIKKA_DATABASE_URL', () => {
  assert.equal(mikkaDatabaseURL({ ...urls, VERCEL_ENV: 'production' }), urls.MIKKA_DATABASE_URL)
  assert.equal(mikkaDatabaseURL({ DATABASE_URL: urls.DATABASE_URL }), undefined)
  assert.equal(workspaceDatabaseURL({ ...urls, VERCEL_ENV: 'production' }), urls.DATABASE_URL)
  assert.equal(workspaceDatabaseURL({ MIKKA_DATABASE_URL: urls.MIKKA_DATABASE_URL }), undefined)
})
