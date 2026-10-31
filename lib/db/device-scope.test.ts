import assert from 'node:assert/strict'
import test from 'node:test'
import { DrizzleQueryError } from 'drizzle-orm'
import { DeviceAuthorityRevoked, isDeviceAuthorityRevoked } from './device-scope'

test('only bounded typed revocation causes map to authentication failure', () => {
  const revoked = new DeviceAuthorityRevoked()
  assert.equal(isDeviceAuthorityRevoked(revoked), true)
  assert.equal(isDeviceAuthorityRevoked(new DrizzleQueryError('begin', [], revoked)), true)
  assert.equal(isDeviceAuthorityRevoked(new DrizzleQueryError('select', [], new Error('SQL failure'))), false)
  assert.equal(isDeviceAuthorityRevoked(new Error('Device authority revoked')), false)
  assert.equal(isDeviceAuthorityRevoked({name:'DeviceAuthorityRevoked'}), false)
  const cycle = new Error('cycle')
  Object.defineProperty(cycle, 'cause', {value:cycle})
  assert.equal(isDeviceAuthorityRevoked(cycle), false)
  const getter = new Error('getter')
  Object.defineProperty(getter, 'cause', {get(){throw new Error('must not invoke')}})
  assert.equal(isDeviceAuthorityRevoked(getter), false)
  let deep: Error = revoked
  for(let i=0;i<9;i++)deep = new Error('wrapped',{cause:deep})
  assert.equal(isDeviceAuthorityRevoked(deep), false)
})
