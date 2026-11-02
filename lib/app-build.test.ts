import test from 'node:test'
import assert from 'node:assert/strict'

import { STALE_BUILD_EVENT, isStaleBuild, reloadOnce, watchRemovedActions } from './app-build'

test('a page is stale only when both builds are known and differ', () => {
  assert.equal(isStaleBuild('dpl_old', 'dpl_new'), true)
  assert.equal(isStaleBuild('dpl_same', 'dpl_same'), false)
  assert.equal(isStaleBuild('', 'dpl_new'), false)
  assert.equal(isStaleBuild('dpl_old', ''), false)
  assert.equal(isStaleBuild('dpl_old', undefined), false)
})

test('a missing server action reloads once a minute at most', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
  let reloads = 0
  assert.equal(reloadOnce(storage, 1_000_000, () => { reloads += 1 }), true)
  assert.equal(reloadOnce(storage, 1_030_000, () => { reloads += 1 }), false)
  assert.equal(reloadOnce(storage, 1_061_000, () => { reloads += 1 }), true)
  assert.equal(reloads, 2)
  // No storage (blocked or private): never loop, ask instead.
  const blocked = { getItem: () => { throw new Error('denied') }, setItem: () => {} }
  assert.equal(reloadOnce(blocked, 2_000_000, () => { reloads += 1 }), false)
  assert.equal(reloadOnce(null, 2_000_000, () => { reloads += 1 }), false)
  assert.equal(reloads, 2)
})

test('a removed server action reloads the page; a second miss within the minute asks instead', async () => {
  const store = new Map<string, string>()
  let reloads = 0
  const events: string[] = []
  const target = {
    fetch: async (input: unknown) => new Response('', { status: input === '/missing' ? 404 : 200, headers: input === '/missing' ? { 'x-nextjs-action-not-found': '1' } : {} }),
    sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } },
    location: { reload: () => { reloads += 1 } },
    dispatchEvent: (event: Event) => { events.push(event.type); return true },
  }
  watchRemovedActions(target as unknown as Window)
  await target.fetch('/ok')
  assert.equal(reloads, 0)
  const response = await target.fetch('/missing')
  assert.equal(response.status, 404)
  assert.equal(reloads, 1)
  await target.fetch('/missing')
  assert.equal(reloads, 1)
  assert.deepEqual(events, [STALE_BUILD_EVENT])
})
