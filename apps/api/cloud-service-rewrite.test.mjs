import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudServiceRewrite } from './cloud-service-rewrite.mjs'

test('community and unconfigured cloud builds add no service rewrite', () => {
  assert.equal(cloudServiceRewrite({}), null)
  assert.equal(cloudServiceRewrite({ MIKKA_EDITION: 'community', MIKKA_CLOUD_BACKEND_URL: 'https://private.example' }), null)
  assert.equal(cloudServiceRewrite({ MIKKA_EDITION: 'cloud' }), null)
})

test('the official service preserves the exact cookie path without matching unrelated routes', () => {
  const rule = cloudServiceRewrite({ MIKKA_EDITION: 'cloud', MIKKA_CLOUD_BACKEND_URL: 'https://private.example' })
  for (const path of ['/mikka/cloud', '/mikka/cloud/manage', '/mikka/cloud/oauth/token', '/mikka/cloud/assets/ui.js']) {
    assert.equal(path.replace(new RegExp(rule.src), rule.dest), `https://private.example${path}`)
  }
  for (const path of ['/mikka/cloud-other', '/mikka/api/auth', '/mikka', '/cloud']) assert.equal(new RegExp(rule.src).test(path), false)
})

test('invalid configured targets fail before a build can publish them', () => {
  for (const target of ['http://private.example', 'https://u:p@private.example', 'https://private.example/cloud', 'https://private.example/', 'https://private.example?a=1', 'https://private.example#x', 'not-a-url']) {
    assert.throws(() => cloudServiceRewrite({ MIKKA_EDITION: 'cloud', MIKKA_CLOUD_BACKEND_URL: target }), { message: 'CLOUD_BACKEND_URL_INVALID' })
  }
})
