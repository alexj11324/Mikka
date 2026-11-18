import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentStage } from './deployment-stage.mjs'

test('explicit application stages override external provider variables without inferring NODE_ENV', () => {
  for (const stage of ['production', 'preview', 'development']) {
    for (const fallback of [undefined, 'production', 'preview', 'development']) {
      const env = Object.freeze({ MIKKA_DEPLOYMENT_STAGE: stage, LEGACY_PROVIDER_ENV: fallback, NODE_ENV: 'production' })
      assert.equal(deploymentStage(env), stage)
    }
  }
  assert.equal(deploymentStage({ NODE_ENV: 'production' }), undefined)
  assert.equal(deploymentStage({ NODE_ENV: 'development' }), undefined)
})

test('unset application stages do not inherit obsolete provider environment variables', () => {
  for (const value of ['production', 'preview', 'development', 'legacy-other', '']) {
    assert.equal(deploymentStage({ VERCEL_ENV: value, NODE_ENV: 'production' }), undefined)
  }
  assert.equal(deploymentStage({}), undefined)
})

test('invalid explicit stages refuse configuration instead of silently falling back or exposing their values', () => {
  for (const value of ['', 'prod', 'Production', 'production ', 'test', 'private-config-value']) {
    assert.throws(() => deploymentStage({ MIKKA_DEPLOYMENT_STAGE: value, MIKKA_DEPLOYMENT_ENVIRONMENT: 'production' }), error => {
      assert.equal(error.message, 'MIKKA_DEPLOYMENT_STAGE_INVALID')
      return true
    })
  }
})


test('target build environment remains compatible and the canonical stage wins', () => {
  assert.equal(deploymentStage({ MIKKA_DEPLOYMENT_ENVIRONMENT: 'preview', MIKKA_DEPLOYMENT_STAGE: undefined }), 'preview')
  assert.equal(deploymentStage({ MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_DEPLOYMENT_ENVIRONMENT: 'preview' }), 'production')
  assert.throws(() => deploymentStage({ MIKKA_DEPLOYMENT_ENVIRONMENT: 'invalid' }), /MIKKA_DEPLOYMENT_STAGE_INVALID/)
})
