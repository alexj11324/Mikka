import assert from 'node:assert/strict'
import test from 'node:test'
import { vercelPreviewProtectionBypass } from './preview-transport'

const bypass = 'x'.repeat(32)

test('only sends Vercel deployment-protection bypass to Vercel preview hosts', () => {
  const env = { VERCEL_ENV: 'preview', MIKKA_CLOUD_PREVIEW_BYPASS: bypass }
  assert.equal(vercelPreviewProtectionBypass('https://mikka-git-pr-1.vercel.app/mikka', env), bypass)
  assert.equal(vercelPreviewProtectionBypass('https://mikka-preview.workers.dev/mikka', env), undefined)
  assert.equal(vercelPreviewProtectionBypass('https://preview.example.net/mikka', env), undefined)
  assert.equal(vercelPreviewProtectionBypass('https://mikka-git-pr-1.vercel.app/mikka', { ...env, VERCEL_ENV: 'production' }), undefined)
})

test('rejects malformed Vercel bypass values but ignores them for unrelated providers', () => {
  const env = { VERCEL_ENV: 'preview', MIKKA_CLOUD_PREVIEW_BYPASS: 'short' }
  assert.throws(() => vercelPreviewProtectionBypass('https://mikka-git-pr-1.vercel.app/mikka', env), /Invalid cloud worker configuration/)
  assert.equal(vercelPreviewProtectionBypass('https://mikka-preview.workers.dev/mikka', env), undefined)
})
