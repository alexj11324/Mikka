import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { SavedAccount } from '../lib/server-store.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const cloud: SavedAccount = { id: 'legacy', user: { id: 'same-id', name: 'A', email: 'a@example.test' }, server: {
  url: 'https://cloud.example/mikka', name: 'Cloud', version: null, edition: 'cloud', signIn: { email: true, google: false, github: false }, mobileReady: true } }
const self: SavedAccount = { ...cloud, id: '1', server: { ...cloud.server, url: 'https://self.example/mikka' } }
let current = cloud, changed: () => void = () => {}, state = 'unknown'
let token: () => Promise<{ data: string }> = async () => ({ data: 'ExpoPushToken[fixture]' })
let request: (method: string, account: SavedAccount) => Promise<void> = async () => {}
const stored = new Map<string, string>()
mock.module('react-native', { namedExports: { AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' } } })
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: { eas: { projectId: 'fixture-project' } } } } })
mock.module('expo-device', { namedExports: { isDevice: true, deviceName: 'Fixture iPhone' } })
mock.module('expo-notifications', { namedExports: { setNotificationHandler() {}, getPermissionsAsync: async () => ({ status: 'granted' }), getExpoPushTokenAsync: () => token() } })
mock.module('expo-secure-store', { namedExports: {
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { stored.set(key, value) },
  deleteItemAsync: async (key: string) => { stored.delete(key) },
} })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: {
  apiConnection: () => ({ account: current }),
  api: (_path: string, init: { method: string }, connection: { account: SavedAccount }) => request(init.method, connection.account),
} })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => current, onServerChange: (listener: () => void) => { changed = listener } } })
mock.module(new URL('../lib/push-state.ts', import.meta.url).href, { namedExports: { pushState: () => state, setPushState: (next: string) => { state = next } } })
const { refreshPush, unregisterPush, forgetPushToken } = await import('../lib/push.ts')

test('a token acquired after a switch does not register the previous account again', async () => {
  current = cloud; changed(); stored.clear()
  const started = deferred<void>(), pending = deferred<{ data: string }>()
  const requests: string[] = []
  token = () => { started.resolve(); return pending.promise }
  request = async (method, account) => { requests.push(`${method} ${account.server.url}`) }
  const refresh = refreshPush()
  await started.promise
  await unregisterPush()
  current = self; changed()
  pending.resolve({ data: 'ExpoPushToken[fixture]' })
  await refresh
  assert.deepEqual(requests, [])
  assert.equal(stored.size, 0)
  assert.equal(state, 'unknown')
})

test('an in-flight registration is removed from its captured server before switching and cannot clear the next account', async () => {
  current = cloud; changed(); stored.clear()
  const posted = deferred<void>(), response = deferred<void>()
  const requests: string[] = []
  token = async () => ({ data: 'ExpoPushToken[fixture]' })
  request = async (method, account) => {
    requests.push(`${method} ${account.server.url}`)
    if (method === 'POST' && account.id === cloud.id) { posted.resolve(); await response.promise }
  }
  const refresh = refreshPush()
  await posted.promise
  const unregister = unregisterPush()
  response.resolve()
  await Promise.all([refresh, unregister])
  assert.deepEqual(requests, ['POST https://cloud.example/mikka', 'DELETE https://cloud.example/mikka'])
  assert.equal(stored.has('mikka_push_token'), false)

  current = self; changed()
  await refreshPush()
  assert.equal(requests.at(-1), 'POST https://self.example/mikka')
  assert.equal(stored.get('mikka_account_1_push_token'), 'ExpoPushToken[fixture]')
  await forgetPushToken(cloud.id)
  assert.equal(stored.get('mikka_account_1_push_token'), 'ExpoPushToken[fixture]')
  assert.equal(state, 'registered')
  // The previous account's late session cleanup did not reset this registration.
  await refreshPush()
  assert.equal(requests.filter(value => value === 'POST https://self.example/mikka').length, 1)
})
