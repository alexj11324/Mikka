import assert from 'node:assert/strict'
import test from 'node:test'
import { PERSONAL_WRITES_ENABLED, personalWritesEnabled } from './write-feature'

test('deployment stays closed by default and the legacy acceptance flag is Preview-only', () => {
  assert.equal(PERSONAL_WRITES_ENABLED,false)
  for (const VERCEL_ENV of [undefined,'production','development','staging']) {
    assert.equal(personalWritesEnabled({VERCEL_ENV,MIKKA_PERSONAL_WRITES_PREVIEW:'1'}),false)
  }
  for (const MIKKA_PERSONAL_WRITES_PREVIEW of [undefined,'0','true']) assert.equal(personalWritesEnabled({VERCEL_ENV:'preview',MIKKA_PERSONAL_WRITES_PREVIEW}),false)
  assert.equal(personalWritesEnabled({VERCEL_ENV:'preview',MIKKA_PERSONAL_WRITES_PREVIEW:'1'}),true)
})

test('server rollout configuration admits production and explicitly closes Preview admission', () => {
  assert.equal(personalWritesEnabled({VERCEL_ENV:'production',MIKKA_PERSONAL_WRITES_ENABLED:'1'}),true)
  for (const MIKKA_PERSONAL_WRITES_ENABLED of ['0','true','', 'false']) {
    assert.equal(personalWritesEnabled({VERCEL_ENV:'production',MIKKA_PERSONAL_WRITES_ENABLED}),false)
    assert.equal(personalWritesEnabled({VERCEL_ENV:'preview',MIKKA_PERSONAL_WRITES_ENABLED,MIKKA_PERSONAL_WRITES_PREVIEW:'1'}),false)
  }
})
