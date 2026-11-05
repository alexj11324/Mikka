import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { unstable_serialize, type Cache } from 'swr'
import { CacheReadError } from '../cache-read-error'
import { chatKeys } from '../swr/keys'
import { ListReadScopeError } from '../live/list-read'

const botId = '10000000-0000-4000-8000-000000000001'
const ownerId = 'fixture-owner'
const oldVersion = 'a'.repeat(32), newVersion = 'b'.repeat(32)
const key = unstable_serialize(chatKeys.detail(botId))
const chat = () => ({ botId, enabled: true, working: false, error: null, cursor: 2, version: oldVersion, live: { ownerId, workspaceId: null },
  continuation: { after: 1, cursor: 2, prefix: 'c'.repeat(32) }, sources: {}, artifacts: {},
  items: [{ position: 1, from: 'person', text: 'Existing message', tools: [], threads: [], artifacts: [], createdAt: '2026-11-05T12:00:00Z' },
    { position: 2, from: 'coordinator', text: 'Existing reply', tools: [], threads: [], artifacts: [], createdAt: '2026-11-05T12:00:01Z' }] })
let hydration: Promise<void>, calls: unknown[][], answer: (...args: unknown[]) => Promise<unknown>
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  syncCoordinatorChat: (...args: unknown[]) => { calls.push(args); return answer(...args) },
} })
mock.module(new URL('../swr/persistent-cache.ts', import.meta.url).href, { namedExports: { waitForCacheHydration: () => hydration } })
let readCachedCoordinatorChat: typeof import('./chat-read-client')['readCachedCoordinatorChat']
before(async () => { ({ readCachedCoordinatorChat } = await import('./chat-read-client')) })
beforeEach(() => { hydration = Promise.resolve(); calls = []; answer = async () => ({ chat: chat() }) })
after(() => mock.restoreAll())

test('startup waits for hydration then sends its saved continuation, never an unseeded full read', async () => {
  const cache: Cache = new Map()
  let release!: () => void
  hydration = new Promise(resolve => { release = resolve })
  const pending = readCachedCoordinatorChat(cache, botId)
  await Promise.resolve()
  assert.equal(calls.length, 0)
  cache.set(key, { data: chat() })
  answer = async () => ({ chat: { ...chat(), version: newVersion, after: 1, baseCursor: 2, items: [chat().items[1]], metadataRefresh: true } })
  release()
  const next = await pending
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], undefined, 'recovered metadata is reauthorized on the first read')
  assert.deepEqual(calls[0][2], { ...chat().continuation, sourceIds: [], artifactIds: [] })
  assert.deepEqual(next.items, chat().items)
  cache.set(key, { data: next })
  answer = async () => ({ chat: { unchanged: true, version: newVersion, cursor: 2, working: false, error: null, botId, enabled: true, live: chat().live, metadata: { sources: {}, artifacts: {} } } })
  const quiet = await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[1][1], newVersion, 'later subscribers share the validated version')
  assert.deepEqual(quiet.items, next.items)
})

test('a newer cache write wins over the response to an older cursor', async () => {
  const cache: Cache = new Map([[key, { data: chat() }]])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  answer = async () => { await gate; return { chat: { ...chat(), version: newVersion, after: 1, baseCursor: 2, cursor: 3 } } }
  const pending = readCachedCoordinatorChat(cache, botId)
  await Promise.resolve()
  const newer = { ...chat(), cursor: 4, version: 'd'.repeat(32), items: [...chat().items, { ...chat().items[1], position: 4, text: 'Newer live response' }] }
  cache.set(key, { data: newer })
  release()
  assert.equal(await pending, newer)
})

test('expected authorization errors retain their code and purge classification without retrying', async () => {
  const cache: Cache = new Map([[key, { data: chat() }]])
  for (const [code, status] of [['authRequired', 401], ['workspaceAccessDenied', 403], ['botNotFound', 404]] as const) {
    answer = async () => ({ error: code })
    await assert.rejects(readCachedCoordinatorChat(cache, botId), error => error instanceof CacheReadError && error.code === code && error.status === status && !error.retryable)
  }
  assert.equal(calls.length, 3)
})

for (const state of ['empty', 'restored'] as const) test(`a foreign account response cannot populate an ${state} cache belonging to the prior viewer`, async () => {
  const cache: Cache = Object.assign(new Map(state === 'restored' ? [[key, { data: chat() }]] : []), { ownerId })
  answer = async () => ({ chat: { ...chat(), live: { ownerId: 'other-viewer', workspaceId: null } } })
  await assert.rejects(readCachedCoordinatorChat(cache, botId), error => error instanceof ListReadScopeError && error.kind === 'owner')
  assert.equal(calls.length, 1)
  assert.ok(!(JSON.stringify(cache.get(key)) ?? '').includes('other-viewer'))
})
