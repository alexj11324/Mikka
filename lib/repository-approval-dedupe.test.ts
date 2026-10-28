import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { pendingActions, repositorySettings } from './db/schema'

let push: unknown = null, pending: { id: string } | null = null, inserts = 0, capacity = 0
const tx = {
  async execute() {},
  select() { let table: unknown; const query = {
    from(value: unknown) { table = value; return query }, where() { return query },
    async limit() { return table === repositorySettings ? [{ push }] : pending ? [pending] : [] },
  }; return query },
  async $count() { return capacity },
  insert(table: unknown) { assert.equal(table, pendingActions); return { async values(row: { id: string }) { inserts++; pending = { id: row.id } } } },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: { transaction: async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx) } } })
mock.module(new URL('./composio.ts', import.meta.url).href, { namedExports: { runComposioAction: async () => { throw new Error('No provider call permitted') } } })
let propose: typeof import('./pending-action-store').proposeRepositoryPush
before(async () => { propose = (await import('./pending-action-store')).proposeRepositoryPush })

test('existing authority and repeated pending requests never create another confirmation', async () => {
  const input = { repo: 'owner/repo' }
  const first = await propose('owner', input)
  assert.ok('status' in first && first.status === 'awaiting_approval')
  capacity = 20
  assert.deepEqual(await propose('owner', input), first)
  assert.equal(inserts, 1)
  push = { approved: true, approvedByUserId: 'owner', approvedAt: '2026-10-28T12:00:00Z', remote: 'origin' }
  assert.deepEqual(await propose('owner', input), { status: 'approved' })
  push = { approved: false }
  assert.deepEqual(await propose('owner', input), { status: 'denied' })
  assert.equal(inserts, 1)
  push = null; pending = null
  assert.deepEqual(await propose('owner', input), { error: 'tooManyPendingActions' })
})
