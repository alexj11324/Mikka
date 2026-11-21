import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { legacyPluginConnections } from '../apps/mobile/lib/plugin-connections'

const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
let failed = false, returnedOwner = 'owner'
let linearAvailability: 'disabled' | 'unavailable' = 'disabled'
const row = (id: string, slug: string, status: string, isDisabled = false) => ({
  id, toolkit: { slug }, status, isDisabled, createdAt: '2026-11-01T00:00:00Z',
})
const fixtures = [row('a', 'third_party', 'EXPIRED'), row('b', 'third_party', 'ACTIVE', true), row('c', 'other', 'ACTIVE'),
  row('d', 'old', 'REVOKED'), row('e', 'unfinished', 'INITIALIZING'), row('f', 'github', 'ACTIVE'),
  row('g', 'denied_by_provider', 'ACTIVE'), row('h', 'expired_only', 'EXPIRED')]
stub('../lib/composio.ts', { getComposio: () => ({ connectedAccounts: { list: async ({ userIds }: {userIds: string[]}) => {
  if (failed) throw new TypeError('synthetic outage')
  return { items: userIds[0] === 'owner' ? fixtures : [] }
} } }) })
stub('../lib/composio-account-store.ts', { listComposioAccountRecords: async (userId: string) => userId === 'owner' ? [{ accountId: 'g', toolkit: 'denied_by_provider', needsReconnect: true }] : [] })
stub('../lib/db/index.ts', { db: {} })
stub('../lib/db/schema.ts', { linearConnections: {} })
stub('../lib/linear-sync/flags.ts', { linearSyncState: async () => linearAvailability })
stub('../lib/linear-sync/oauth.ts', { linearOAuthConfigured: () => true })
class GitHubAccessError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }
stub('../lib/github/user-access.ts', { GitHubAccessError, listAuthorizedRepositories: async () => ({ userId: returnedOwner, installations: ['one'] }) })
stub('../lib/telegram/connection-status.ts', { readTelegramIntegrationStatus: async (id: string) => ({ configured: true, connected: id === 'owner' }) })
let read: typeof import('../lib/mobile-plugin-connections').mobilePluginConnections
before(async () => { read = (await import('../lib/mobile-plugin-connections')).mobilePluginConnections })
beforeEach(() => { failed = false; returnedOwner = 'owner'; linearAvailability = 'disabled' })

test('Settings count and both native plugin lists receive one unique set of held accounts', async () => {
  const summary = await read('owner', new Headers())
  assert.deepEqual(summary.toolkits.sort(), ['denied_by_provider', 'expired_only', 'github', 'other', 'telegram', 'third_party'])
  assert.deepEqual(summary.states, { third_party: 'paused', other: 'active', denied_by_provider: 'needsReconnect', expired_only: 'needsReconnect', github: 'active', telegram: 'active' })
  assert.deepEqual(summary.paused, ['linear'])
  assert.deepEqual(summary.failed, [])
})

test('a partial provider outage retains confirmed accounts and its reason, then recovers', async () => {
  failed = true
  const summary = await read('owner', new Headers())
  assert.deepEqual(summary.toolkits.sort(), ['github', 'telegram'])
  assert.deepEqual(summary.failed, [{ source: 'composio', reason: 'TypeError' }])
  failed = false
  assert.ok((await read('owner', new Headers())).toolkits.includes('third_party'))
})

test('wrong-owner Github membership cannot appear in another user’s list', async () => {
  const summary = await read('another', new Headers())
  assert.deepEqual(summary.toolkits, [])
  assert.deepEqual(summary.failed, [{ source: 'github', reason: 'authRequired' }])
})

test('an old server uses the canonical account feed and advertises unavailable first-party status', () => {
  const summary = legacyPluginConnections({ apps: [{ app: 'linear', connected: true, account: 'Example' }] },
    { configured: true, accounts: [{ id: 'a', toolkit: 'third_party', status: 'EXPIRED', alias: null, email: null }] }, { enabled: true })
  assert.deepEqual(summary.toolkits, ['third_party', 'linear'])
  assert.deepEqual(summary.states, { third_party: 'needsReconnect', linear: 'active' })
  assert.deepEqual(summary.failed.map(item => item.source), ['github', 'telegram'])
})

test('global Linear pause never reads its connection table or claims account ownership', async () => {
  for (const availability of ['disabled', 'unavailable'] as const) {
    linearAvailability = availability
    const snapshot = await read('owner', new Headers())
    assert.deepEqual(snapshot.paused, ['linear'])
    assert.equal(snapshot.toolkits.includes('linear'), false)
    assert.deepEqual(snapshot.failed, [])
  }
  const old = legacyPluginConnections({ apps: [{ app: 'linear', connected: true, account: 'Example' }] },
    { configured: true, accounts: [] }, { enabled: false })
  assert.deepEqual(old.paused, ['linear'])
  assert.deepEqual(old.toolkits, [])
  assert.ok(legacyPluginConnections({ apps: [] }, null, null).failed.some(failure => failure.source === 'linear'))
})
