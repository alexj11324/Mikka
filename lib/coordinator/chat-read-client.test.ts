import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { unstable_serialize, type Cache } from 'swr'
import { CacheReadError } from '../cache-read-error'
import { chatKeys } from '../swr/keys'
import { ListReadScopeError } from '../live/list-read'
import { persistentReadData } from '../swr/cache-policy'

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

test('a projected tool in the historical prefix restores metadata without replaying its body, then resumes cursor reads', async () => {
  const tool = { call: 'call-1', name: 'github_call', state: 'error', at: 0, target: 'private/repo', displayName: 'GitHub · Dynamic operation', errorCode: 'upstream_denied', errorDetail: 'workspace_mismatch' }
  const full = { ...chat(), cursor: 500, continuation: { after: 490, cursor: 500, prefix: 'c'.repeat(32) }, items: [
    { ...chat().items[1], position: 301, activity: { tools: [tool] } }, { ...chat().items[1], position: 500 },
  ] }
  const projected = persistentReadData(chatKeys.detail(botId), full) as typeof full
  assert.deepEqual(projected.continuation, full.continuation)
  assert.ok(!JSON.stringify(projected).includes('private/repo'))
  const cache: Cache = new Map([[key, { data: projected }]])
  answer = async () => ({ chat: { ...full, after: 490, baseCursor: 500, items: [full.items[1]], toolMetadata: {
    baseCursor: 500, prefix: full.continuation.prefix, rows: [
      { position: 301, parts: [{ ordinal: 1, type: 'tool-call', toolCallId: 'call-1', toolName: 'github_call', target: tool.target, operationName: 'dynamic_operation' }] },
      { position: 302, parts: [{ ordinal: 1, type: 'tool-result', toolCallId: 'call-1', status: 'error', errorCode: tool.errorCode, errorDetail: tool.errorDetail }] },
    ],
  } } })
  const repaired = await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[0][1], undefined)
  assert.deepEqual(calls[0][2], { ...full.continuation, restoreToolMetadata: true, sourceIds: [], artifactIds: [] })
  assert.deepEqual(repaired.items[0].activity?.tools[0], tool, 'the overlay restores metadata before the saved tail cursor')
  assert.equal(repaired.items[0].text, full.items[0].text, 'the prefix body stayed in the cache')
  assert.equal('toolMetadata' in repaired, false)
  assert.equal('restoreToolMetadata' in repaired, false)
  cache.set(key, { data: repaired })
  answer = async () => ({ chat: { unchanged: true, version: oldVersion, cursor: 500, working: false, error: null, botId, enabled: true, live: chat().live } })
  await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[1][1], oldVersion)
  assert.deepEqual(calls[1][2], { ...full.continuation, sourceIds: [], artifactIds: [] })
})

test('missing prefix metadata takes one bounded full reset and consumes the repair hint', async () => {
  const preview = { ...chat(), restoreToolMetadata: true }
  const cache: Cache = new Map([[key, { data: preview }]])
  answer = async () => ({ chat: calls.length === 1 ? { ...chat(), after: 1, baseCursor: 2, items: [chat().items[1]] } : chat() })
  const repaired = await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], [botId])
  assert.equal('restoreToolMetadata' in repaired, false)
})

for (const change of ['object', 'prefix'] as const) test(`a late metadata overlay cannot validate or overwrite a same-cursor ${change} change`, async () => {
  const preview = { ...chat(), restoreToolMetadata: true }
  const cache: Cache = new Map([[key, { data: preview }]])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  answer = async () => { await gate; return { chat: { ...chat(), after: 1, baseCursor: 2, items: [chat().items[1]],
    toolMetadata: { baseCursor: 2, prefix: 'c'.repeat(32), rows: [] } } } }
  const pending = readCachedCoordinatorChat(cache, botId)
  await Promise.resolve()
  const newer = change === 'object' ? { ...preview } : preview
  if (change === 'prefix') newer.continuation.prefix = 'd'.repeat(32)
  cache.set(key, { data: newer })
  release()
  assert.equal(await pending, newer)
  assert.equal(newer.restoreToolMetadata, true)
  answer = async () => ({ chat: chat() })
  await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[1][1], undefined, 'a discarded overlay must not validate the old preview')
})

test('the metadata fallback full read also preserves an in-place prefix change while in flight', async () => {
  const preview = { ...chat(), restoreToolMetadata: true }
  const cache: Cache = new Map([[key, { data: preview }]])
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fullStarted = new Promise<void>(resolve => { started = resolve })
  answer = async () => {
    if (calls.length === 1) return { chat: { ...chat(), after: 1, baseCursor: 2, items: [chat().items[1]] } }
    started(); await gate; return { chat: chat() }
  }
  const pending = readCachedCoordinatorChat(cache, botId)
  await fullStarted
  preview.continuation.prefix = 'd'.repeat(32)
  release()
  assert.equal(await pending, preview)
  assert.equal(preview.restoreToolMetadata, true)
  answer = async () => ({ chat: chat() })
  await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[2][1], undefined)
})

test('a late full repair preserves a newer cache write and leaves the preview unvalidated', async () => {
  const preview = { ...chat(), continuation: undefined }
  const cache: Cache = new Map([[key, { data: preview }]])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  answer = async () => { await gate; return { chat: chat() } }
  const pending = readCachedCoordinatorChat(cache, botId)
  await Promise.resolve()
  const newer = { ...preview, version: newVersion, cursor: 3, items: [...preview.items, { ...preview.items[1], position: 3, text: 'Newly saved reply' }] }
  cache.set(key, { data: newer })
  release()
  assert.equal(await pending, newer)
  answer = async () => ({ chat: { ...chat(), ...newer } })
  await readCachedCoordinatorChat(cache, botId)
  assert.equal(calls[1][1], undefined, 'discarding a full response cannot mark an old projected prefix as verified')
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
