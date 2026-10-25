import assert from 'node:assert/strict'
import test from 'node:test'
import { listComposioPages } from './composio-pagination'

test('loads every Composio page in cursor order', async () => {
  const cursors: (string | undefined)[] = []
  const items = await listComposioPages(async cursor => {
    cursors.push(cursor)
    return cursor ? { items: ['second'], nextCursor: null } : { items: ['first'], nextCursor: 'next' }
  })

  assert.deepEqual(cursors, [undefined, 'next'])
  assert.deepEqual(items, ['first', 'second'])
})

test('bounds repeated cursors, total pages and an already aborted operation', async () => {
  let calls = 0
  await assert.rejects(listComposioPages(async () => { calls++; return { items: [], nextCursor: 'same' } }), /pagination bound/)
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(listComposioPages(async () => { calls++; return { items: [], nextCursor: String(calls) } }, { maxPages: 3 }), /pagination bound/)
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(listComposioPages(async () => { calls++; return { items: [] } }, { signal: AbortSignal.abort() }))
  assert.equal(calls, 0)
})
