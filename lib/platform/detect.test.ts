import test from 'node:test'
import assert from 'node:assert/strict'

import type { MikkaBridge } from '@mikka/protocol/bridge'

import { bridgeFromWindow, detectPlatform, platformFromBridge } from './detect'

function bridge(overrides: Partial<MikkaBridge> = {}): MikkaBridge {
  return {
    app: { version: '0.1.0', flavor: 'dev', runtime: 'electron', serverUrl: 'https://app.example/mikka', zeroUrl: 'https://zero.example', openExternal: async () => {} },
    auth: {} as MikkaBridge['auth'],
    settings: { getAll: async () => ({}) as never, set: async () => ({}) as never },
    notifications: { show: async () => {}, setBadge: async () => {}, onClick: () => () => {}, consumePendingClick: async () => null },
    device: { status: async () => ({ status: 'offline', deviceId: null, workspaceId: null, signedIn: false, server: null }), link: async () => ({ status: 'offline', deviceId: null, workspaceId: null, signedIn: false, server: null }), pickRepo: async () => ({ status: 'cancelled' }) },
    quota: { get: async () => ({ status: 'unknown' }) as never },
    preview: { html: async () => 'mikka-preview://x' },
    ...overrides,
  }
}

test('no bridge means the web platform and no capabilities', () => {
  for (const snapshot of [detectPlatform(null), detectPlatform({ mikka: undefined } as never), platformFromBridge(null)]) {
    assert.equal(snapshot.runtime, 'web')
    assert.equal(snapshot.bridge, null)
    for (const value of Object.values(snapshot.capabilities)) assert.equal(value, false)
  }
})

test('a browser-runtime bridge is still web', () => {
  const browser = bridge({ app: { ...bridge().app, runtime: 'browser' } })
  assert.equal(detectPlatform({ mikka: browser } as never).runtime, 'web')
  assert.equal(bridgeFromWindow({ mikka: browser } as never), null)
})

test('an electron bridge reports every subsystem it exposes', () => {
  const snapshot = detectPlatform({ mikka: bridge() } as never)
  assert.equal(snapshot.runtime, 'desktop')
  assert.deepEqual(snapshot.capabilities, {
    'app.info': true,
    'notifications.system': true,
    'notifications.badge': true,
    'device.localIdentity': true,
    'device.pickRepo': true,
    'quota.snapshot': true,
    'preview.scheme': true,
    'settings.local': true,
  })
})

test('a missing subsystem turns only its capability off', () => {
  const minimal = bridge()
  const snapshot = platformFromBridge({
    ...minimal,
    notifications: { show: async () => {}, setBadge: async () => {}, onClick: () => () => {}, consumePendingClick: async () => null },
    quota: undefined as never,
    preview: undefined as never,
  })
  assert.equal(snapshot.runtime, 'desktop')
  assert.equal(snapshot.capabilities['notifications.system'], true)
  assert.equal(snapshot.capabilities['quota.snapshot'], false)
  assert.equal(snapshot.capabilities['preview.scheme'], false)
  assert.equal(snapshot.capabilities['device.localIdentity'], true)
})

test('detection never reads the user agent', () => {
  const snapshot = detectPlatform({ mikka: undefined, navigator: { userAgent: 'Electron/45.0.0', platform: 'MacIntel' } } as never)
  assert.equal(snapshot.runtime, 'web')
})
