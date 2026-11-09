import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ownerLiveReadScope, ownerLiveScope } from '../live/owner-scope'
import { readBatchOwnerRevisions, readBatchRevisions, withReadBatchContext } from './read-batch-context'

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

test('planned owner readers share one earlier observation without exposing each other\'s keys', async () => {
  let revision = 7
  const calls: string[][][] = []
  const database = { query: async (_sql: string, values: string[][]) => {
    calls.push(values)
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: String(revision) })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const home = { ownerId: owner, workspaceId: workspace }, issueKey = `issue_list:${workspace}`
  await withReadBatchContext(async () => {
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], home), { [threadKey]: 7 })
    revision = 12
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }], home), { [issueKey]: 7 })
  }, ['task-runs.syncThreadList', 'issues.syncIssueList'])
  assert.deepEqual(calls, [[['issue_list', 'thread_list'], [workspace, workspace]]])
  assert.deepEqual(await withReadBatchContext(() => readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }], home), ['issues.syncIssueList']), { [issueKey]: 12 })
  assert.equal(calls.length, 2, 'another request observes the current revision')
})

test('an undeclared batch keeps ordinary per-reader observations', async () => {
  let queries = 0, revision = 7
  const database = { query: async (_sql: string, values: string[][]) => {
    queries++; assert.equal(values[0].length, 1)
    return { rows: [{ kind: values[0][0], id: values[1][0], revision: String(revision) }] }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const home = { ownerId: owner, workspaceId: workspace }
  await withReadBatchContext(async () => {
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], home), { [threadKey]: 7 })
    revision = 12
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'task_run_list', id: workspace }], home), { [taskKey]: 12 })
  })
  assert.equal(queries, 2)
})

test('a selected team key stays late and total requested and returned keys stay unchanged', async () => {
  const team = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const run = async (planned: boolean) => {
    const calls: string[][][] = [], returned: number[] = []
    const database = { query: async (_sql: string, values: string[][]) => {
      calls.push(values); returned.push(values[0].length)
      return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: '7' })) }
    } } as unknown as Parameters<typeof readBatchRevisions>[0]
    const values = await withReadBatchContext(async () => {
      const home = { ownerId: owner, workspaceId: workspace }
      const thread = await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], home)
      const issues = await readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }, { kind: 'issue_list', id: team }], home)
      return { thread, issues }
    }, planned ? ['task-runs.syncThreadList', 'issues.syncIssueList'] : [])
    return { calls, returned, values }
  }
  const before = await run(false), after = await run(true)
  assert.deepEqual(after.values, before.values)
  assert.equal(before.calls.length, 2); assert.equal(after.calls.length, 2)
  assert.equal(before.returned.reduce((a, b) => a + b), 3)
  assert.equal(after.returned.reduce((a, b) => a + b), 3)
  assert.deepEqual(after.calls, [[['issue_list', 'thread_list'], [workspace, workspace]], [['issue_list'], [team]]])
})

test('owner homes and database authorities do not borrow another planned observation', async () => {
  const peer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const homes = { query: async (_sql: string, values: string[]) => ({ rows: [{ ownerId: values[0], workspaceId: values[0] === owner ? workspace : peer }] }) } as unknown as Parameters<typeof ownerLiveScope>[0]
  const counts = [0, 0]
  const database = (index: number) => ({ query: async (_sql: string, values: string[][]) => {
    counts[index]++
    return { rows: values[0].map((kind, i) => ({ kind, id: values[1][i], revision: String((index ? 20 : 0) + (values[1][i] === workspace ? 7 : 12)) })) }
  } }) as unknown as Parameters<typeof readBatchRevisions>[0]
  const first = database(0), second = database(1)
  await withReadBatchContext(async () => {
    const a = await ownerLiveReadScope(homes, owner), b = await ownerLiveReadScope(homes, peer)
    assert.ok(a && b)
    assert.deepEqual(await readBatchOwnerRevisions(first, [{ kind: 'thread_list', id: workspace }], a), { [threadKey]: 7 })
    assert.deepEqual(await readBatchOwnerRevisions(first, [{ kind: 'thread_list', id: peer }], b), { [`thread_list:${peer}`]: 12 })
    assert.deepEqual(await readBatchOwnerRevisions(second, [{ kind: 'thread_list', id: workspace }], a), { [threadKey]: 27 })
  }, ['task-runs.syncThreadList', 'issues.syncIssueList'])
  assert.deepEqual(counts, [2, 1])
})

test('absent homes and invalid or nonrevision refs never trigger an owner prefetch', async () => {
  let queries = 0
  const database = { query: async (_sql: string, values: string[][]) => {
    queries++; assert.deepEqual(values[0], ['thread_list'])
    return { rows: [{ kind: 'thread_list', id: workspace, revision: '7' }] }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  await withReadBatchContext(async () => {
    for (const refs of [[], [{ kind: 'device_list' as const, id: workspace }], [{ kind: 'thread_list' as const, id: 'invalid' }]])
      assert.deepEqual(await readBatchOwnerRevisions(database, refs, { ownerId: owner, workspaceId: workspace }), {})
    assert.equal(queries, 0)
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], null), { [threadKey]: 7 })
  }, ['task-runs.syncThreadList', 'issues.syncIssueList'])
  assert.equal(queries, 1)
})

test('an entity or another owner key does not start the resolved home\'s list prefetch', async () => {
  const peer = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const calls: string[][][] = []
  const database = { query: async (_sql: string, values: string[][]) => {
    calls.push(values)
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: '7' })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  await withReadBatchContext(async () => {
    const home = { ownerId: owner, workspaceId: workspace }
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'bot_chat', id: peer }], home), { [`bot_chat:${peer}`]: 7 })
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: peer }], home), { [`thread_list:${peer}`]: 7 })
  }, ['task-runs.syncThreadList', 'issues.syncIssueList'])
  assert.deepEqual(calls, [[['bot_chat'], [peer]], [['thread_list'], [peer]]])
})

test('missing and failed prefetched revisions remain unknown until another request reads', async () => {
  const home = { ownerId: owner, workspaceId: workspace }, issueKey = `issue_list:${workspace}`
  const failure = new Error('fixture revision unavailable')
  let unavailable = false, queries = 0
  const database = { query: async (_sql: string, values: string[][]) => {
    queries++; if (unavailable) throw failure
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: kind === 'thread_list' ? '7' : 'invalid' })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const read = async () => {
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], home), { [threadKey]: 7 })
    assert.deepEqual(await readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }], home), {})
  }
  const plan = ['task-runs.syncThreadList', 'issues.syncIssueList'] as const
  await withReadBatchContext(read, plan)
  assert.equal(queries, 1)
  unavailable = true
  await withReadBatchContext(async () => {
    await assert.rejects(readBatchOwnerRevisions(database, [{ kind: 'thread_list', id: workspace }], home), error => error === failure)
    await assert.rejects(readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }], home), error => error === failure)
  }, plan)
  assert.equal(queries, 2, 'the failed prefetched key is not silently retried or fabricated')
  unavailable = false
  await withReadBatchContext(read, plan)
  assert.equal(queries, 3)
  assert.equal(Object.hasOwn(await readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: workspace }], home), issueKey), false)
})

test('throw and cancellation release the plan as well as its earlier observations', async () => {
  for (const failure of [new Error('fixture thrown'), new DOMException('fixture cancelled', 'AbortError')]) {
    let revision = 7, after!: () => Promise<unknown>
    const calls: string[][][] = []
    const database = { query: async (_sql: string, values: string[][]) => {
      calls.push(values)
      return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: String(revision) })) }
    } } as unknown as Parameters<typeof readBatchRevisions>[0]
    const home = { ownerId: owner, workspaceId: workspace }, refs = [{ kind: 'thread_list' as const, id: workspace }]
    await assert.rejects(withReadBatchContext(async () => {
      await readBatchOwnerRevisions(database, refs, home)
      after = AsyncLocalStorage.bind(() => readBatchOwnerRevisions(database, refs, home))
      throw failure
    }, ['task-runs.syncThreadList', 'issues.syncIssueList']), error => error === failure)
    revision = 12
    assert.deepEqual(await after(), { [threadKey]: 12 })
    assert.deepEqual(await after(), { [threadKey]: 12 })
    assert.deepEqual(calls.map(values => values[0]), [['issue_list', 'thread_list'], ['thread_list'], ['thread_list']])
  }
})
