import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ownerLiveReadScope, ownerLiveScope } from '../live/owner-scope'
import { readBatchRevisions, withReadBatchContext } from './read-batch-context'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const workspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const threadKey = `thread_list:${workspace}`
const taskKey = `task_run_list:${workspace}`

test('concurrent owner-wide readers reuse their actual personal home only within the batch', async () => {
  let queries = 0, member = true
  const database = { query: async () => { queries++; return { rows: member ? [{ ownerId: owner, workspaceId: workspace }] : [] } } } as unknown as Parameters<typeof ownerLiveScope>[0]
  const reads = await withReadBatchContext(() => Promise.all([
    ownerLiveReadScope(database, owner), ownerLiveReadScope(database, owner),
  ]))
  assert.deepEqual(reads, [{ ownerId: owner, workspaceId: workspace }, { ownerId: owner, workspaceId: workspace }])
  assert.equal(queries, 1, 'one real membership/home query for the two batch readers')
  member = false
  assert.equal(await withReadBatchContext(() => ownerLiveReadScope(database, owner)), null)
  assert.equal(queries, 2, 'the next HTTP batch must observe revoked membership')
  await Promise.all([ownerLiveReadScope(database, owner), ownerLiveReadScope(database, owner)])
  assert.equal(queries, 4, 'ordinary reads have no added cross-request cache')
})

test('different Live kinds share one revision query before either consumer reads its data', async () => {
  let queries = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const database = { query: async (_sql: string, values: string[][]) => {
    queries++
    await barrier
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: kind === 'thread_list' ? '7' : '9' })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const events: string[] = []
  const pending = withReadBatchContext(() => Promise.all([
    readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }]).then(value => { events.push('thread-data'); return value }),
    readBatchRevisions(database, [{ kind: 'task_run_list', id: workspace }]).then(value => { events.push('task-data'); return value }),
  ]))
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(events, [], 'data must wait for its revision observation')
  release()
  assert.deepEqual(await pending, [{ [threadKey]: 7 }, { [taskKey]: 9 }])
  assert.equal(queries, 1, 'the two validated kinds share one bounded SQL read')
})

test('owner observations are separate for parallel batches, owners and database authorities', async () => {
  let queries = 0
  const peer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const database = { query: async (_sql: string, values: string[]) => {
    queries++; await Promise.resolve()
    return { rows: [{ ownerId: values[0], workspaceId: values[0] === owner ? workspace : peer }] }
  } } as unknown as Parameters<typeof ownerLiveScope>[0]
  const read = () => withReadBatchContext(() => Promise.all([
    ownerLiveReadScope(database, owner), ownerLiveReadScope(database, owner), ownerLiveReadScope(database, peer),
  ]))
  const results = await Promise.all([read(), read()])
  assert.equal(queries, 4, 'each HTTP batch independently resolves both owners')
  for (const rows of results) assert.deepEqual(rows, [
    { ownerId: owner, workspaceId: workspace }, { ownerId: owner, workspaceId: workspace }, { ownerId: peer, workspaceId: peer },
  ])
  const otherDatabase = { query: async () => { queries++; return { rows: [] } } } as unknown as Parameters<typeof ownerLiveScope>[0]
  assert.deepEqual(await withReadBatchContext(() => Promise.all([
    ownerLiveReadScope(database, owner), ownerLiveReadScope(otherDatabase, owner),
  ])), [{ ownerId: owner, workspaceId: workspace }, null])
  assert.equal(queries, 6)
})

test('later reads in one batch keep the earlier revision, while the next batch reads the new revision', async () => {
  let queries = 0, revision = 7
  const database = { query: async (_sql: string, values: string[][]) => {
    queries++
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: String(revision) })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  await withReadBatchContext(async () => {
    assert.deepEqual(await readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }]), { [threadKey]: 7 })
    revision = 12
    assert.deepEqual(await readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }, { kind: 'task_run_list', id: workspace }]), { [threadKey]: 7, [taskKey]: 12 })
    assert.equal(queries, 2, 'only the newly requested kind needs another query')
  })
  assert.deepEqual(await withReadBatchContext(() => readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }])), { [threadKey]: 12 })
  assert.equal(queries, 3)
})

test('a missing or failed revision never becomes fabricated proof and does not poison the next request', async () => {
  let queries = 0, unavailable = true
  const failure = Object.assign(new Error('fixture unavailable'), { code: '08006' })
  const database = { query: async () => {
    queries++
    if (unavailable) throw failure
    return { rows: [] }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const results = await withReadBatchContext(() => Promise.allSettled([
    readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }]),
    readBatchRevisions(database, [{ kind: 'task_run_list', id: workspace }]),
  ]))
  assert.equal(queries, 1)
  for (const result of results) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, failure) }
  unavailable = false
  assert.deepEqual(await withReadBatchContext(() => readBatchRevisions(database, [{ kind: 'thread_list', id: workspace }])), {})
  assert.equal(queries, 2)
  assert.deepEqual(await withReadBatchContext(() => readBatchRevisions(database, [])), {})
  assert.equal(queries, 2, 'empty refs never issue SQL')
})

test('ordinary revision readers and different database scopes remain independent', async () => {
  let queries = 0
  const database = { query: async () => { queries++; return { rows: [{ kind: 'thread_list', id: workspace, revision: '3' }] } } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const otherDatabase = { query: async () => { queries++; return { rows: [{ kind: 'thread_list', id: workspace, revision: '8' }] } } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const refs = [{ kind: 'thread_list' as const, id: workspace }]
  assert.deepEqual(await withReadBatchContext(() => Promise.all([
    readBatchRevisions(database, refs), readBatchRevisions(otherDatabase, refs),
  ])), [{ [threadKey]: 3 }, { [threadKey]: 8 }])
  assert.equal(queries, 2)
  await Promise.all([readBatchRevisions(database, refs), readBatchRevisions(database, refs)])
  assert.equal(queries, 4)
})

test('bound after-work cannot reuse an already completed batch authority observation', async () => {
  let queries = 0, member = true, after!: () => Promise<unknown>
  const database = { query: async () => { queries++; return { rows: member ? [{ ownerId: owner, workspaceId: workspace }] : [] } } } as unknown as Parameters<typeof ownerLiveScope>[0]
  await withReadBatchContext(async () => {
    await ownerLiveReadScope(database, owner)
    after = AsyncLocalStorage.bind(() => ownerLiveReadScope(database, owner))
  })
  member = false
  assert.equal(await after(), null)
  assert.equal(await after(), null)
  assert.equal(queries, 3)
})

test('notification target resolution never inherits an earlier list-read home, even inside the batch', async () => {
  let queries = 0, created = false
  const database = { query: async () => { queries++; return { rows: created ? [{ ownerId: owner, workspaceId: workspace }] : [] } } } as unknown as Parameters<typeof ownerLiveScope>[0]
  await withReadBatchContext(async () => {
    assert.equal(await ownerLiveReadScope(database, owner), null)
    created = true
    assert.deepEqual(await ownerLiveScope(database, owner), { ownerId: owner, workspaceId: workspace }, 'ordinary writer/notification scope is fresh')
    assert.equal(await ownerLiveReadScope(database, owner), null, 'the earlier list keeps its actual earlier observation')
  })
  assert.equal(queries, 2)
})
