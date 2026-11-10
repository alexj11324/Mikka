import assert from 'node:assert/strict'
import test from 'node:test'
import { MobileServerStore, accountStorageKey, SERVER_STORE_KEY, type MobileServer } from '../lib/server-store.ts'
import { pushBelongsToAccount } from '../lib/push-route.ts'

const cloud: MobileServer = { url: 'https://app.aspectlylabs.com/mikka', name: 'Mikka Cloud', version: null, edition: 'cloud',
  signIn: { google: true, github: true, apple: true, email: true }, mobileReady: true }
const self: MobileServer = { ...cloud, url: 'https://self.example.test/mikka', name: 'Acme Mikka', edition: 'community', version: 'revision' }
const user = { id: 'same-id-on-both-servers', name: 'Alex', email: 'alex@example.test' }
function fixture() {
  const values = new Map<string, string>()
  let fail = false
  const storage = { getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { if (fail) throw Error('storage unavailable'); values.set(key, value) } }
  return { values, storage, store: new MobileServerStore(storage, cloud), fail: (value: boolean) => { fail = value } }
}

test('existing cloud cookies migrate without copying a credential into another server slot', async () => {
  const f = fixture(); await f.store.initialize()
  assert.equal(f.store.current().id, 'legacy')
  assert.equal(accountStorageKey('legacy', 'cookie'), 'mikka_cookie')
  await f.store.remember('legacy', user)
  await f.store.add(self)
  assert.equal(f.store.current().server.url, self.url)
  assert.notEqual(accountStorageKey(f.store.current().id, 'cookie'), 'mikka_cookie')
  await f.store.remember(f.store.current().id, user)
  assert.equal(f.store.snapshot().accounts.length, 2, 'identical user ids from separate installations never merge')
  assert.equal(f.store.snapshot().accounts[0].server.url, cloud.url)
  const restored = new MobileServerStore(f.storage, cloud)
  await restored.initialize()
  assert.equal(restored.current().server.url, self.url)
  assert.equal(restored.current().user?.id, user.id)
  await restored.select('legacy')
  assert.equal(restored.current().server.url, cloud.url)
  assert.equal(restored.current().user?.email, user.email)
})

test('two accounts on one server have separate cookie, workspace and push namespaces', async () => {
  const f = fixture(); await f.store.initialize(); await f.store.remember('legacy', user); await f.store.add(cloud)
  const next = f.store.current().id
  await f.store.remember(next, { ...user, id: 'second', email: 'second@example.test' })
  for (const suffix of ['cookie', 'session_data', 'workspace', 'workspace_order', 'push_token']) assert.notEqual(accountStorageKey(next, suffix), accountStorageKey('legacy', suffix))
  await f.store.signedOut(next)
  assert.equal(f.store.current().user, null)
  assert.equal(f.store.snapshot().accounts[0].user?.id, user.id)
  await assert.rejects(f.store.describe('legacy', self), /mobile_account_server_changed/)
})

test('a failed save never switches the live account and retry persists before notifying', async () => {
  const f = fixture(); await f.store.initialize()
  const observed: string[] = []
  f.store.subscribe(() => { assert.ok(f.values.has(SERVER_STORE_KEY)); observed.push(f.store.current().server.url) })
  f.fail(true)
  await assert.rejects(f.store.add(self))
  assert.equal(f.store.current().server.url, cloud.url); assert.equal(observed.length, 0)
  f.fail(false); await f.store.add(self)
  assert.deepEqual(observed, [self.url])
})

test('corrupt saved accounts do not silently send their credentials to the default server', async () => {
  const f = fixture(); f.values.set(SERVER_STORE_KEY, '{broken')
  await assert.rejects(f.store.initialize())
  assert.equal(f.store.snapshot().ready, false)
})

test('a native adapter that silently drops a write never changes the active server', async () => {
  const store = new MobileServerStore({ getItemAsync: async () => null, setItemAsync: async () => {} }, cloud)
  await store.initialize()
  await assert.rejects(store.add(self), /mobile_accounts_save_failed/)
  assert.equal(store.current().server.url, cloud.url)
})

test('a corrupt slot counter cannot reuse another account cookie jar', async () => {
  const f = fixture(); await f.store.initialize(); await f.store.add(self)
  const stored = JSON.parse(f.values.get(SERVER_STORE_KEY)!)
  stored.next = 1
  f.values.set(SERVER_STORE_KEY, JSON.stringify(stored))
  await assert.rejects(new MobileServerStore(f.storage, cloud).initialize(), /mobile_accounts_invalid/)
})

test('push taps and foreground banners match both server and account', () => {
  const account = { id: '1', server: self, user }
  assert.equal(pushBelongsToAccount({ serverUrl: self.url, userId: user.id }, account), true)
  for (const data of [{ serverUrl: cloud.url, userId: user.id }, { serverUrl: self.url, userId: 'other' }, { botId: 'same-bot-id' }, { serverUrl: self.url }]) assert.equal(pushBelongsToAccount(data, account), false)
  assert.equal(pushBelongsToAccount({}, { ...account, id: 'legacy', server: cloud }), true)
  assert.equal(pushBelongsToAccount({}, { ...account, id: '2', server: cloud }), false)
  assert.equal(pushBelongsToAccount({ serverUrl: self.url, userId: user.id }, { ...account, user: null }), false)
})


test('saved servers predating Apple discovery enable only the official cloud fallback', async () => {
  const f = fixture(); await f.store.initialize(); await f.store.add(self)
  const stored = JSON.parse(f.values.get(SERVER_STORE_KEY)!)
  for (const account of stored.accounts) delete account.server.signIn.apple
  f.values.set(SERVER_STORE_KEY, JSON.stringify(stored))
  const restored = new MobileServerStore(f.storage, cloud)
  await restored.initialize()
  assert.equal(restored.snapshot().accounts[0].server.signIn.apple, true)
  assert.equal(restored.snapshot().accounts[1].server.signIn.apple, false)
  stored.accounts[0].server.signIn.apple = false
  f.values.set(SERVER_STORE_KEY, JSON.stringify(stored))
  const disabled = new MobileServerStore(f.storage, cloud)
  await disabled.initialize()
  assert.equal(disabled.snapshot().accounts[0].server.signIn.apple, false)
})
