import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { SavedAccount } from '../lib/server-store.ts'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const first: SavedAccount = { id: 'legacy', user: { id: 'same-id', name: 'A', email: 'a@example.test' }, server: {
  url: 'https://cloud.example/mikka', name: 'Cloud', version: null, edition: 'cloud', signIn: { email: true, google: false, github: false, apple: false }, mobileReady: true } }
const second: SavedAccount = { ...first, id: '1', server: { ...first.server, url: 'https://self.example/mikka' }, user: { ...first.user!, name: 'B' } }
let current = first, ended = 0
const cookie = deferred<string>()
const client = { getCookie: () => cookie.promise }
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' } } })
mock.module('expo-secure-store', { namedExports: { getItemAsync: async () => null, setItemAsync: async () => {} } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: client } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => current } })
mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { endLostSession: async () => { ended++ } } })
mock.module(new URL('../lib/tracing.ts', import.meta.url).href, { namedExports: { mobileTraceHeaders: () => ({ 'x-mikka-client': 'mobile' }) } })
const { api, apiConnection } = await import('../lib/api.ts')
const { apiCache } = await import('../lib/api-cache.ts')
const { presenceScope } = await import('../lib/presence-scope.ts')
const { readPresentedTasks, readPresentedTask } = await import('../features/tasks/model/task-presentation-read.ts')

test('a server switch while keychain reads cannot send the old cookie to the new server or sign it out', async t => {
  const requests: { url: string; cookie: string | null; redirect?: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie'), redirect: init?.redirect })
    return Response.json({ error: 'expired' }, { status: 401 })
  }
  t.after(() => { globalThis.fetch = original })
  apiCache.setIdentity('legacy:same-id')
  const connection = apiConnection()
  const pending = api('/api/mobile/settings', {}, connection)
  current = second; apiCache.setIdentity('1:same-id')
  cookie.resolve('better-auth.session_token=old-server-private')
  await assert.rejects(pending)
  assert.deepEqual(requests, [{ url: `${first.server.url}/api/mobile/settings`, cookie: 'better-auth.session_token=old-server-private', redirect: 'error' }])
  assert.equal(ended, 0)
  // A follow-up in an old upload/handoff retains the old connection too.
  await assert.rejects(api('/api/mobile/follow-up', {}, connection))
  assert.equal(requests[1].url, `${first.server.url}/api/mobile/follow-up`)
  assert.equal(ended, 0)
})

test('an old explicit server connection cannot acquire the current server home proof', async t => {
  const requests: { url: string; scope: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), scope: new Headers(init?.headers).get('x-mikka-presence-scope') })
    return Response.json({})
  }
  t.after(() => { globalThis.fetch = original; presenceScope.clear() })
  current = second
  apiCache.setIdentity('1:same-id', 'same-id')
  const home = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72', token = `home.${'a'.repeat(64)}`, expiresAt = Date.now() + 60_000
  presenceScope.remember(home, { expiresAt, homeScope: { ownerId: 'same-id', workspaceId: home, expiresAt, token } }, presenceScope.begin())
  await api('/api/mobile/threads', {}, { account: first, client: apiConnection().client })
  await api('/api/mobile/threads')
  assert.deepEqual(requests, [
    { url: `${first.server.url}/api/mobile/threads`, scope: null },
    { url: `${second.server.url}/api/mobile/threads`, scope: token },
  ])
})

test('the mobile list and detail use the same authorized Factory state with one POST per 200 distinct tasks', async t => {
  const workspaceId = '81818181-0000-4000-8000-000000000001'
  const tasks = Array.from({ length: 201 }, (_, index) => ({ id: String(index), title: String(index), state: 'done', status: 'done' }))
  const projection = { version: 1, state: 'waiting', reason: 'pr_review', group: 'pending', blockedBy: null, primaryStatus: 'review' }
  const batches: string[][] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/mobile/task-presentations')) {
      assert.equal(init.method, 'POST')
      const input = JSON.parse(String(init.body)) as { workspaceId: string; issueIds: string[] }
      assert.equal(input.workspaceId, workspaceId)
      batches.push(input.issueIds)
      return Response.json({ version: 1, workspaceId, items: Object.fromEntries(input.issueIds.filter(id => id !== '200').map(id => [id, projection])) })
    }
    return Response.json(url.endsWith('/tasks') ? { workspaceId, tasks } : { task: tasks[0], activity: [], live: { workspaceId } })
  })
  const list = await readPresentedTasks('/api/mobile/tasks')
  const detail = await readPresentedTask('/api/mobile/tasks/0')
  assert.equal(list.tasks.length, 200, 'a task omitted by the authorized projection disappears')
  assert.deepEqual(list.tasks[0], detail.task)
  assert.deepEqual([detail.task.state, detail.task.reason, detail.task.status], ['waiting', 'pr_review', 'review'])
  assert.deepEqual(batches.map(batch => batch.length), [200, 1, 1])
})

test('a tenant mismatch in the second mobile response rejects the read', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.endsWith('/tasks')
    ? { workspaceId: 'a', tasks: [{ id: '1' }] }
    : { version: 1, workspaceId: 'b', items: { '1': { state: 'done' } } }))
  await assert.rejects(readPresentedTasks('/api/mobile/tasks'), /taskPresentationScopeMismatch/)
})
