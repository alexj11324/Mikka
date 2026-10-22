import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mikkaDatabaseURL } from './config'

const urls = { DATABASE_URL: 'postgres://preview', MIKKA_DATABASE_URL: 'postgres://mikka', ORVILO_DATABASE_URL: 'postgres://legacy' }

test('Preview uses the Neon integration branch rather than global database overrides', () => {
  assert.equal(mikkaDatabaseURL({ ...urls, VERCEL_ENV: 'preview' }), urls.DATABASE_URL)
  assert.equal(mikkaDatabaseURL({ ...urls, DATABASE_URL: undefined, VERCEL_ENV: 'preview' }), urls.MIKKA_DATABASE_URL)
})

test('other deployments retain Mikka and legacy precedence', () => {
  assert.equal(mikkaDatabaseURL({ ...urls, VERCEL_ENV: 'production' }), urls.MIKKA_DATABASE_URL)
  assert.equal(mikkaDatabaseURL({ ORVILO_DATABASE_URL: urls.ORVILO_DATABASE_URL }), urls.ORVILO_DATABASE_URL)
  assert.equal(mikkaDatabaseURL({ DATABASE_URL: urls.DATABASE_URL }), undefined)
})
