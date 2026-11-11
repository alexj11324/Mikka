import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyConfiguration, verifyImage } from '../../../cloudflare/api/start.mjs'

const build = 'a'.repeat(40), overlay = 'b'.repeat(40), id = 'aaaaaaaaaaaa-1949-1'
const env = {
  NODE_ENV: 'production', MIKKA_EDITION: 'cloud',
  BETTER_AUTH_URL: 'https://app.example', MIKKA_EVE_ORIGIN: 'https://eve.example',
  BETTER_AUTH_SECRET: 'test', DATABASE_URL: 'postgres://workspace',
  MIKKA_DATABASE_URL: 'postgres://mikka', WORKFLOW_TARGET_WORLD: '@test/durable-world',
}

test('the hosted API uses the exact official node-server build, overlay and deployment', () => {
  const args = { MIKKA_BUILD_REVISION: build, MIKKA_UI_OVERLAY_SHA: overlay, MIKKA_DEPLOYMENT_ID: id }
  const evidence = { preset: 'node-server', revision: build, overlaySha: overlay, deploymentId: id }
  verifyImage(evidence, args)
  for (const key of Object.keys(evidence)) assert.throws(() => verifyImage({ ...evidence, [key]: 'stale' }, args))
  for (const key of Object.keys(args)) assert.throws(() => verifyImage(evidence, { ...args, [key]: '' }))
})

test('the hosted API needs two trusted service origins, existing PostgreSQL configuration and an external workflow target', () => {
  verifyConfiguration(env)
  for (const key of Object.keys(env)) assert.throws(() => verifyConfiguration({ ...env, [key]: '' }))
  for (const value of [env.BETTER_AUTH_URL, 'https://eve.example/mikka/api/agents', 'http://eve.example', 'https://someone@eve.example', 'https://*.example']) {
    assert.throws(() => verifyConfiguration({ ...env, MIKKA_EVE_ORIGIN: value }), /ORIGINS_INVALID/)
  }
  for (const choice of ['local', 'vercel', '@workflow/world-local', '@workflow/world-vercel']) {
    assert.throws(() => verifyConfiguration({ ...env, WORKFLOW_TARGET_WORLD: choice }), /HOSTED_WORLD_REQUIRED/)
  }
  assert.throws(() => verifyConfiguration({ ...env, VERCEL_ENV: 'production' }), /EDITION_INVALID/)
})
