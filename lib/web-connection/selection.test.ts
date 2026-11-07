import assert from 'node:assert/strict'
import test from 'node:test'
import { selectedLiveURLAllowed } from './selection'
import { readCacheNamespace } from '../swr/persistent-cache'
import { connectedAssetPath } from './assets'
import { withBasePath } from '../base-path'

test('self-hosted live tickets cannot redirect capabilities to the cloud or a different origin', () => {
  const server = 'https://self.test/mikka'
  assert.equal(selectedLiveURLAllowed('wss://self.test/mikka/v1/live/id/socket', server), true)
  for (const url of ['wss://app.aspectlylabs.com/mikka/v1/live/id/socket', 'wss://self.test.evil.test/mikka/socket', 'ws://self.test/mikka/socket', 'wss://self.test/other/socket', 'wss://user:password@self.test/mikka/socket']) {
    assert.equal(selectedLiveURLAllowed(url, server), false, url)
  }
  assert.equal(selectedLiveURLAllowed('wss://official-gateway.test/live/socket', null), true)
})

test('persistent caches cannot share a namespace across servers even with identical account and workspace ids', () => {
  const scope = { userId: 'same-person', workspaceId: 'same-workspace', role: 'owner', build: 'same-build' }
  const cloud = readCacheNamespace(scope)
  const first = readCacheNamespace({ ...scope, server: 'https://first.test/mikka' })
  const second = readCacheNamespace({ ...scope, server: 'https://second.test/mikka' })
  assert.equal(new Set([cloud, first, second]).size, 3)
  assert.equal(cloud, JSON.stringify([1, scope.userId, scope.workspaceId, scope.build, scope.role]))
})

test('authenticated assets only accept application API paths, never foreign or executable URLs', () => {
  const path = withBasePath('/api/artifacts/id/versions/1/download')
  assert.equal(connectedAssetPath(path, 'https://app.test'), `https://app.test${path}`)
  for (const path of ['https://foreign.test/mikka/api/file', 'javascript:alert(1)', '//foreign.test/mikka/api/file', '/mikka/sign-in']) {
    assert.throws(() => connectedAssetPath(path, 'https://app.test'), /web_connection_origin_refused/)
  }
})
