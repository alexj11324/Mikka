// A task push action bound to its account and context (#1659 item 4): the real api, saveWorkspace, apiCache, server
// store, switchWorkspace and opener; only HTTP, OS storage, the prompt and the navigation sink are stubbed.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const stored = new Map<string, string>()
const storage = {
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { stored.set(key, value) },
  deleteItemAsync: async (key: string) => { stored.delete(key) },
}
const pushed: string[] = [], alerts: string[] = []
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' }, Alert: { alert: (title: string) => { alerts.push(title) } }, AppState: { addEventListener: () => ({ remove() {} }) } } })
mock.module('expo-secure-store', { namedExports: storage })
mock.module('expo-constants', { defaultExport: { expoConfig: { version: '1.0.0' } } })
mock.module('expo-application', { namedExports: { nativeApplicationVersion: '1.0.0' } })
mock.module('@better-auth/expo/client', { namedExports: { storageAdapter: () => storage, expoClient: () => ({}) } })
mock.module('expo-router', { namedExports: { router: { canDismiss: () => false, dismissAll() {}, navigate() {}, push: (href: string) => { pushed.push(href) } } } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: { getCookie: () => 'session=fixture' } } })

const { servers } = await import('../lib/config.ts')
const { apiCache } = await import('../lib/api-cache.ts')
const { onWorkspaceChange, saveWorkspace } = await import('../lib/api.ts')
const { accountStorageKey } = await import('../lib/server-store.ts')
const { openTaskPush } = await import('../lib/task-push-app.ts')

const alpha = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const beta = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const gamma = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const task = '22222222-2222-4222-8222-222222222222', other = '33333333-3333-4333-8333-333333333333'
const keyA = accountStorageKey('legacy', 'workspace'), keyB = accountStorageKey('1', 'workspace')

// Every screen's cache is dropped on a switch, as lib/useApi.ts does once it is loaded.
onWorkspaceChange(() => apiCache.clear())
await servers.initialize()
await servers.add({ ...servers.current().server, url: 'https://self.example/mikka', name: 'Self' })
await servers.select('legacy')

/** The server: GET /api/mobile/settings answers the cookie's workspace when the person is in it, else Beta. */
type Reply = (workspace: string) => Promise<Response>
const settings = (workspace: string) => new Response(JSON.stringify({ workspace: { id: workspace }, workspaces: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
let replies: Reply[] = []
const requests: string[] = []
globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
  requests.push(url)
  const workspace = /mikka-workspace=([0-9a-f-]+)/.exec(init.headers.cookie ?? '')?.[1]
  const answer = [alpha, beta, gamma].includes(workspace ?? '') ? workspace! : beta
  return (replies.shift() ?? (async (w: string) => settings(w)))(answer)
}) as typeof fetch

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(done => setImmediate(done)) }
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(done => setImmediate(done)) }

async function reset() {
  await servers.select('legacy')
  apiCache.setIdentity('legacy:user-a', 'user-a')
  stored.set(keyA, beta); stored.delete(keyB)
  pushed.length = 0; alerts.length = 0; requests.length = 0; replies = []
}

test('positive control: Beta selected, a push in Alpha switches A to Alpha and opens the task', async () => {
  await reset()
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => pushed.length > 0)
  assert.deepEqual(pushed, [`/task/${task}?workspace=${alpha}`])
  assert.equal(stored.get(keyA), alpha)
  assert.equal(requests.length, 2)
  assert.deepEqual(alerts, [])
})

test('a refusal in the same context restores the previous selection and shows the feedback', async () => {
  await reset()
  // Alpha is not this person's: the read-back answers Beta, the server's fallback.
  replies = [async w => settings(w), async () => settings(beta)]
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => alerts.length > 0)
  assert.equal(stored.get(keyA), beta)
  assert.deepEqual(pushed, [])
  assert.equal(alerts.length, 1)
})

test('race 1: the person picks Gamma while the first settings read is pending; the old answer stops the push', async () => {
  await reset()
  const first = deferred<Response>()
  replies = [() => first.promise]
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => requests.length === 1)
  await saveWorkspace(gamma)
  first.resolve(settings(beta))
  await settle()
  assert.equal(stored.get(keyA), gamma, 'the person\'s Gamma is kept')
  assert.deepEqual(pushed, [])
  assert.equal(requests.length, 1, 'no save, no read-back')
  assert.deepEqual(alerts, [])
})

test('race 2: account A → B while the first read is pending; nothing is written to B and nothing opens', async () => {
  await reset()
  const first = deferred<Response>()
  replies = [() => first.promise]
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => requests.length === 1)
  await servers.select('1')
  apiCache.setIdentity('1:user-b', 'user-b')
  first.resolve(settings(beta))
  await settle()
  assert.equal(stored.has(keyB), false, 'B\'s namespace is untouched')
  assert.equal(stored.get(keyA), beta)
  assert.deepEqual(pushed, [])
  assert.equal(requests.length, 1)
  assert.deepEqual(alerts, [])
})

test('race 3: A → B while the second confirmation is pending, then it fails; no rollback is written to B', async () => {
  await reset()
  const second = deferred<Response>()
  replies = [async w => settings(w), () => second.promise]
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => requests.length === 2)
  assert.equal(stored.get(keyA), alpha, 'the action\'s own save, in A')
  await servers.select('1')
  apiCache.setIdentity('1:user-b', 'user-b')
  second.reject(new TypeError('Network request failed'))
  await settle()
  assert.equal(stored.has(keyB), false, 'A\'s Beta is never rolled back into B')
  assert.deepEqual(pushed, [])
  assert.equal(requests.length, 2)
  assert.deepEqual(alerts, [])
})

test('race 4: a second push queued in A, then A → B before it runs; it stops on the account it was tapped in', async () => {
  await reset()
  const first = deferred<Response>()
  replies = [() => first.promise]
  openTaskPush({ workspaceId: alpha, issueId: task, runId: null })
  await until(() => requests.length === 1)
  // Accepted while the first is still waiting: it queues behind it, in A.
  openTaskPush({ workspaceId: alpha, issueId: other, runId: null })
  await servers.select('1')
  apiCache.setIdentity('1:user-b', 'user-b')
  first.resolve(settings(beta))
  await settle()
  assert.equal(stored.has(keyB), false, 'no read, save or rollback for the queued push in B')
  assert.equal(stored.get(keyA), beta)
  assert.deepEqual(pushed, [])
  assert.equal(requests.length, 1, 'the queued push sends nothing once A is no longer current')
  assert.deepEqual(alerts, [])
})

test('a newer push in the same account supersedes the waiting one before it writes, then opens itself', async () => {
  await reset()
  const first = deferred<Response>()
  replies = [() => first.promise]
  openTaskPush({ workspaceId: gamma, issueId: task, runId: null })
  await until(() => requests.length === 1)
  openTaskPush({ workspaceId: alpha, issueId: other, runId: null })
  first.resolve(settings(beta))
  await until(() => pushed.length > 0)
  await settle()
  assert.deepEqual(pushed, [`/task/${other}?workspace=${alpha}`], 'only the newer push opens')
  assert.equal(stored.get(keyA), alpha, 'the older push never saved Gamma')
  assert.deepEqual(alerts, [])
})
