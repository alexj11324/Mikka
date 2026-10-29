import assert from 'node:assert/strict'
import test from 'node:test'
import { PERSONAL_WRITES_ENABLED, personalWritesEnabled } from './write-feature'

test('only explicit server Preview configuration admits acceptance; production stays closed', () => {
  assert.equal(PERSONAL_WRITES_ENABLED,false)
  for (const VERCEL_ENV of [undefined,'production','development','staging']) {
    assert.equal(personalWritesEnabled({VERCEL_ENV,MIKKA_PERSONAL_WRITES_PREVIEW:'1'}),false)
  }
  for (const MIKKA_PERSONAL_WRITES_PREVIEW of [undefined,'0','true']) assert.equal(personalWritesEnabled({VERCEL_ENV:'preview',MIKKA_PERSONAL_WRITES_PREVIEW}),false)
  assert.equal(personalWritesEnabled({VERCEL_ENV:'preview',MIKKA_PERSONAL_WRITES_PREVIEW:'1'}),true)
})
