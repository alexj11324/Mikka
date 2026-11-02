import test from 'node:test'
import assert from 'node:assert/strict'

import { isStaleBuild, onCallError, reloadOnce, reportCallError } from './app-build'

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

test('call errors reach every listener until it unsubscribes', () => {
  const seen: unknown[] = []
  const off = onCallError(error => seen.push(error))
  reportCallError('a')
  off()
  reportCallError('b')
  assert.deepEqual(seen, ['a'])
})
