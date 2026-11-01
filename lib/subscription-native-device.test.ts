import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nativeProxyDevice } from './subscription-native-device'

const broker = [{ subscriptionBroker: true }]

test('a person\'s own device with the broker capability may use the subscription proxy', () => {
  assert.equal(nativeProxyDevice({ enabled: true, kind: 'local', harnesses: broker }, 'd1', ''), true)
})

test('a cloud machine needs the hosted allow-list', () => {
  assert.equal(nativeProxyDevice({ enabled: true, kind: 'cloud', harnesses: broker }, 'd1', ''), false)
  assert.equal(nativeProxyDevice({ enabled: true, kind: 'cloud', harnesses: broker }, 'd1', 'd0,d1'), true)
})

test('a device without the capability, a disabled one, or none is refused', () => {
  assert.equal(nativeProxyDevice({ enabled: true, kind: 'local', harnesses: [{}] }, 'd1', 'd1'), false)
  assert.equal(nativeProxyDevice({ enabled: false, kind: 'local', harnesses: broker }, 'd1', 'd1'), false)
  assert.equal(nativeProxyDevice(null, 'd1', 'd1'), false)
})
