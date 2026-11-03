import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { PERSONAL_WRITES_ENABLED, personalWritesEnabled } from './write-feature'
import { overrideDeploymentSwitch } from '@/lib/deployment-switches'

afterEach(() => overrideDeploymentSwitch('personalWrites', undefined))

test('personal writes ship on in every deployment scope without a Preview opt-in', () => {
  assert.equal(PERSONAL_WRITES_ENABLED,true)
  assert.equal(personalWritesEnabled(),true)
})

test('only the kill switch closes admission; the old variable no longer decides', () => {
  overrideDeploymentSwitch('personalWrites', true)
  assert.equal(personalWritesEnabled(),true)
  overrideDeploymentSwitch('personalWrites', false)
  assert.equal(personalWritesEnabled(),false)
  overrideDeploymentSwitch('personalWrites', undefined)
  const previous = process.env.MIKKA_PERSONAL_WRITES_ENABLED
  try {
    for (const value of ['0','true','', 'false']) {
      process.env.MIKKA_PERSONAL_WRITES_ENABLED = value
      assert.equal(personalWritesEnabled(),true)
    }
  } finally {
    if (previous === undefined) delete process.env.MIKKA_PERSONAL_WRITES_ENABLED
    else process.env.MIKKA_PERSONAL_WRITES_ENABLED = previous
  }
})
