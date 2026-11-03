import test from 'node:test'
import assert from 'node:assert/strict'

import type { LocalDevice } from '@mikka/protocol/bridge'
import { localSetupAction } from './local-device-setup'

const daemon = (patch: Partial<LocalDevice>): LocalDevice => ({ status: 'online', deviceId: 'mac', workspaceId: null, signedIn: true, server: 'online', ...patch })

test('first launch: no daemon answers, so restart it or install it', () => {
  assert.equal(localSetupAction({ status: 'offline', deviceId: null, workspaceId: null, signedIn: false, server: null }, []), 'repair')
})

test('already my device: nothing to do, online or with its server link down for a moment', () => {
  assert.equal(localSetupAction(daemon({}), ['mac']), 'none')
  assert.equal(localSetupAction(daemon({ server: 'offline' }), ['mac']), 'none')
  assert.equal(localSetupAction(daemon({ status: 'connecting' }), ['mac']), 'none')
})

test('a daemon with no device, or someone else\'s, is set up for me', () => {
  assert.equal(localSetupAction(daemon({ deviceId: null, signedIn: false, server: 'unregistered' }), ['mac']), 'install')
  assert.equal(localSetupAction(daemon({ deviceId: 'theirs' }), ['mac']), 'install')
})
