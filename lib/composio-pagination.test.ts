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
