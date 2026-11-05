import assert from 'node:assert/strict'
import test from 'node:test'
import { unstable_serialize, type Cache, type Key, type useSWRConfig } from 'swr'
import { prefetchScopedRead } from './prefetch'
import { settingsKeys } from './keys'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const scopedMutate = (cache: Cache) => (async (key: Key, value: unknown) => {
  const id = unstable_serialize(key)
  cache.set(id, { ...cache.get(id), data: value })
  return value
}) as ReturnType<typeof useSWRConfig>['mutate']

test('intent prefetch deduplicates per provider without sharing one account result with another', async () => {
  const one: Cache = new Map(), two: Cache = new Map()
  const key = settingsKeys.issuePrefix(), held = deferred<{ prefix: string }>()
  let reads = 0
  const read = () => { reads++; return held.promise }
  const first = prefetchScopedRead(one, scopedMutate(one), key, read)
  const duplicate = prefetchScopedRead(one, scopedMutate(one), key, read)
  const other = prefetchScopedRead(two, scopedMutate(two), key, async () => ({ prefix: 'TWO' }))
  await settle()
  assert.equal(reads, 1)
  held.resolve({ prefix: 'ONE' })
  await Promise.all([first, duplicate, other])
  assert.deepEqual(one.get(key)?.data, { prefix: 'ONE' })
  assert.deepEqual(two.get(key)?.data, { prefix: 'TWO' })
  await prefetchScopedRead(one, scopedMutate(one), key, read)
  assert.equal(reads, 1)
})

test('mounted reads and optimistic writes win over late speculative results', async () => {
  for (const next of [{ isValidating: true }, { data: { prefix: 'SAVED' } }]) {
    const cache: Cache = new Map(), key = settingsKeys.issuePrefix(), held = deferred<unknown>()
    const request = prefetchScopedRead(cache, scopedMutate(cache), key, () => held.promise)
    await settle()
    cache.set(key, next)
    held.resolve({ prefix: 'OLD' })
    await request
    assert.equal(cache.get(key), next)
  }
})

test('failed intent reads can be attempted by later user intent and do not loop on their own', async () => {
  const cache: Cache = new Map(), key = settingsKeys.issuePrefix()
  let reads = 0
  const read = async () => { reads++; throw new TypeError('offline') }
  await prefetchScopedRead(cache, scopedMutate(cache), key, read)
  await settle()
  assert.equal(reads, 1)
  assert.equal(cache.get(key), undefined)
  await prefetchScopedRead(cache, scopedMutate(cache), key, read)
  assert.equal(reads, 2)
})
