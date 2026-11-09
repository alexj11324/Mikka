import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { SavedAccount } from '../lib/server-store.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const cloud: SavedAccount = { id: 'legacy', user: { id: 'same-id', name: 'A', email: 'a@example.test' }, server: {
  url: 'https://cloud.example/mikka', name: 'Cloud', version: null, edition: 'cloud', signIn: { email: true, google: false, github: false, apple: false }, mobileReady: true } }
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
const { refreshPush, unregisterPush, forgetPushToken, setPushSession, CONFIRMED_FOR_MS } = await import('../lib/push.ts')

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

// #1659: the server binds the token to the native session that posts it. A confirmation counts only for that session.
test('sign-in registers; a same-session return to the front posts nothing more', async () => {
  current = cloud; changed(); stored.clear()
  const requests: string[] = []
  token = async () => ({ data: 'ExpoPushToken[fixture]' })
  request = async (method, account) => { requests.push(`${method} ${account.server.url}`) }
  // Sign-in: the session is known first, then watchPushes registers.
  assert.equal(setPushSession('session-a'), null)
  await refreshPush()
  assert.deepEqual(requests, ['POST https://cloud.example/mikka'])
  assert.equal(state, 'registered')
  // Back to the front in the same session: the server already confirmed this binding.
  await refreshPush()
  await refreshPush()
  assert.deepEqual(requests, ['POST https://cloud.example/mikka'])
})

test('the same token under a new session registers again, once', async () => {
  current = cloud; changed(); stored.clear()
  const requests: string[] = []
  token = async () => ({ data: 'ExpoPushToken[fixture]' })
  request = async (method, account) => { requests.push(`${method} ${account.server.url}`) }
  setPushSession('session-b')
  await refreshPush()
  assert.equal(requests.length, 1)
  // The session changes (signed in again, same phone and token): it registers at once.
  await setPushSession('session-c')
  assert.equal(requests.length, 2)
  // Returning to the front afterwards needs nothing more; an unchanged session is not a change.
  assert.equal(setPushSession('session-c'), null)
  await refreshPush()
  assert.equal(requests.length, 2)
})

test('a failed registration is not taken as confirmed: the next return to the front posts again', async () => {
  current = cloud; changed(); stored.clear()
  let fail = true
  const requests: string[] = []
  token = async () => ({ data: 'ExpoPushToken[fixture]' })
  request = async method => { requests.push(method); if (fail) throw new Error('offline') }
  // A new session registers at once; the server is unreachable.
  await setPushSession('session-d')
  assert.equal(state, 'failed')
  fail = false
  await refreshPush()
  assert.deepEqual(requests, ['POST', 'POST'])
  assert.equal(state, 'registered')
})

test('an old confirmation is redone on the next return to the front, never on a timer', async () => {
  current = cloud; changed(); stored.clear()
  const requests: string[] = []
  token = async () => ({ data: 'ExpoPushToken[fixture]' })
  request = async method => { requests.push(method) }
  const start = Date.now()
  const now = mock.method(Date, 'now', () => start)
  try {
    await setPushSession('session-e')
    now.mock.mockImplementation(() => start + CONFIRMED_FOR_MS - 1)
    await refreshPush()
    assert.deepEqual(requests, ['POST'])
    now.mock.mockImplementation(() => start + CONFIRMED_FOR_MS)
    await refreshPush()
    assert.deepEqual(requests, ['POST', 'POST'])
  } finally { now.mock.restore() }
})
