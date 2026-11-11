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

import { apiRequest } from '../../../cloudflare/api/ingress/request.mjs'
import { ingressConfig } from '../../../cloudflare/api/ingress/config.mjs'

test('private ingress keeps authority, body, cookies and upgrades while replacing client proxy fields', async () => {
  const origin = 'https://app.example'
  const request = new Request(origin + '/mikka/api/rpc', { method: 'POST', body: 'payload',
    headers: { authorization: 'Bearer fixture', cookie: 'fixture', 'cf-connecting-ip': '192.0.2.31',
      forwarded: 'for=bad', 'x-forwarded-host': 'other.example', 'x-mikka-edge-ip': '192.0.2.99',
      'cf-container-target-port': '9000', 'x-vercel-ip-city': 'bad', 'x-forwarded-for': '192.0.2.10' } })
  assert.equal(apiRequest(request, 'https://other.example'), null)
  const forwarded = apiRequest(request, origin)
  assert.equal(await forwarded.text(), 'payload')
  for (const [key, value] of Object.entries({ host: 'app.example', authorization: 'Bearer fixture', cookie: 'fixture',
    'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https', 'x-mikka-edge-ip': '192.0.2.31' })) assert.equal(forwarded.headers.get(key), value)
  for (const key of ['forwarded', 'x-vercel-ip-city', 'x-forwarded-for', 'cf-container-target-port', 'cf-connecting-ip']) assert.equal(forwarded.headers.has(key), false)
  const upgrade = apiRequest(new Request(origin + '/mikka/api/stream', { headers: { upgrade: 'websocket' } }), origin)
  assert.equal(upgrade.headers.get('upgrade'), 'websocket')
  assert.equal(upgrade.headers.get('x-mikka-edge-ip'), null)
})

test('ingress binds only the immutable account image with a private route and a bounded staging pool', () => {
  const input = { release: id, origin: 'https://app.example', image: 'registry.cloudflare.com/' + 'e'.repeat(32) + '/mikka-api@sha256:' + '3'.repeat(64) }
  const config = ingressConfig(input)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.containers[0].max_instances, 1)
  assert.equal(config.containers[0].image, input.image)
  for (const changed of [{ release: 'main' }, { image: input.image.split('@')[0] + ':latest' }, { origin: 'https://user@app.example' }]) {
    assert.throws(() => ingressConfig({ ...input, ...changed }))
  }
})
