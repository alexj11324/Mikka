import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedReadStorage, type StoredRead } from './indexed-db'

const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
beforeEach(() => { Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() }) })
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'indexedDB', original)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
})
const value = (title: string): StoredRead => ({ key: 'preferences', rawKey: 'preferences', data: { title }, savedAt: 1 })

test('real IndexedDB transactions fence late writes from the previously active account', async () => {
  const oldTab = new IndexedReadStorage(), newTab = new IndexedReadStorage()
  await oldTab.activate('account-a')
  await oldTab.write('account-a', value('old account'))
  assert.deepEqual(await newTab.activate('account-b'), [])
  await newTab.write('account-b', value('new account'))
  await oldTab.write('account-a', value('late old response'))
  const rows = await newTab.activate('account-b')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].data, { title: 'new account' })
})

test('retiring an old tab clears only its namespace and preserves the current active gate', async () => {
  const oldTab = new IndexedReadStorage(), newTab = new IndexedReadStorage()
  await oldTab.activate('account-a')
  await newTab.activate('account-b')
  await newTab.write('account-b', value('new account'))
  await oldTab.clear('account-a')
  await newTab.write('account-b', value('still active'))
  assert.deepEqual((await newTab.activate('account-b')).map(row => row.data), [{ title: 'still active' }])
})

test('logout clears the active gate so an in-flight response cannot recreate disk data', async () => {
  const storage = new IndexedReadStorage()
  await storage.activate('account-a')
  await storage.write('account-a', value('before logout'))
  await storage.clear()
  await storage.write('account-a', value('late response'))
  assert.deepEqual(await storage.activate('account-a'), [])
})

test('an activation invalidated while IndexedDB opens cannot replace the new account', async () => {
  const oldTab = new IndexedReadStorage(), newTab = new IndexedReadStorage()
  let current = true
  const delayed = oldTab.activate('account-a', () => current)
  current = false
  await newTab.activate('account-b')
  await newTab.write('account-b', value('new account'))
  assert.deepEqual(await delayed, [])
  assert.deepEqual((await newTab.activate('account-b')).map(row => row.data), [{ title: 'new account' }])
})
