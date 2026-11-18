import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectCronRelease } from './select-release.mjs'
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: 'a'.repeat(40) }
function network(provider) { return async url => {
  if (String(url).startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 3, Question: [{ name: '_mikka-release.aspectlylabs.com.', type: 16 }] })
  return Response.json({ build: env.GITHUB_SHA }, { headers: provider === 'cloudflare' ? { 'cf-ray': 'fixture', 'x-mikka-gateway-version-sha256': 'b'.repeat(64) } : { 'x-vercel-id': 'fixture' } })
} }
test('manual release selects Cloudflare only and rejects non-main execution', async () => {
  assert.equal(await selectCronRelease(env, network('cloudflare')), true)
  assert.equal(await selectCronRelease(env, network('vercel')), false)
  await assert.rejects(selectCronRelease({ ...env, GITHUB_REF: 'refs/pull/3/merge' }, network('cloudflare')), /reviewed_main_workflow_required/)
})
