import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentStage } from './deployment-stage.mjs'

test('explicit application stages override platform defaults without enabling a platform or inferring NODE_ENV', () => {
  for (const stage of ['production', 'preview', 'development']) {
    for (const fallback of [undefined, 'production', 'preview', 'development']) {
      const env = Object.freeze({ MIKKA_DEPLOYMENT_STAGE: stage, VERCEL_ENV: fallback, NODE_ENV: 'production' })
      assert.equal(deploymentStage(env), stage)
      assert.equal('VERCEL' in env, false)
    }
  }
  assert.equal(deploymentStage({ NODE_ENV: 'production' }), undefined)
  assert.equal(deploymentStage({ NODE_ENV: 'development' }), undefined)
})

test('unset application stages preserve legacy production, preview, development and local semantics', () => {
  assert.equal(deploymentStage({ VERCEL_ENV: 'production' }), 'production')
  assert.equal(deploymentStage({ VERCEL_ENV: 'preview' }), 'preview')
  assert.equal(deploymentStage({ VERCEL_ENV: 'development' }), 'development')
  assert.equal(deploymentStage({ VERCEL_ENV: 'legacy-other' }), 'development')
  assert.equal(deploymentStage({ VERCEL_ENV: '' }), undefined)
  assert.equal(deploymentStage({}), undefined)
})

test('invalid explicit stages refuse configuration instead of silently falling back or exposing their values', () => {
  for (const value of ['', 'prod', 'Production', 'production ', 'test', 'private-config-value']) {
    assert.throws(() => deploymentStage({ MIKKA_DEPLOYMENT_STAGE: value, VERCEL_ENV: 'production' }), error => {
      assert.equal(error.message, 'MIKKA_DEPLOYMENT_STAGE_INVALID')
      return true
    })
  }
})


test('target build environment remains compatible and the canonical stage wins', () => {
  assert.equal(deploymentStage({ MIKKA_DEPLOYMENT_ENVIRONMENT: 'preview', VERCEL_ENV: 'production' }), 'preview')
  assert.equal(deploymentStage({ MIKKA_DEPLOYMENT_STAGE: 'production', MIKKA_DEPLOYMENT_ENVIRONMENT: 'preview' }), 'production')
  assert.throws(() => deploymentStage({ MIKKA_DEPLOYMENT_ENVIRONMENT: 'invalid' }), /MIKKA_DEPLOYMENT_STAGE_INVALID/)
})
