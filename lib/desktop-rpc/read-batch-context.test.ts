import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ownerLiveReadScope, ownerLiveScope } from '../live/owner-scope'
import { readBatchOwnerRevisions, readBatchRevisions, withReadBatchContext } from './read-batch-context'
import * as readContext from './read-batch-context'
import { readPendingWorkspaceChoices } from './workspace-choices'
import { COMMIT_EXECUTOR } from '../db/commit-effects'
import { routeScope } from '../tracing/labels'

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

// The old source executes its real per-reader queue for RED comparison, so a
// failed count is behavioral rather than a missing new export.
const workspaceRevisions: typeof readContext.readBatchWorkspaceRevisions =
  readContext.readBatchWorkspaceRevisions ?? ((database, refs) => readBatchRevisions(database, refs))
const workspacePlan = ['task-runs.syncThreadList', 'task-runs.pollTaskRuns', 'issues.syncIssueList'] as const
const selectedTeam = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function workspaceRevisionFixture(initial = 7) {
  let revision = initial
  const calls: string[][][] = []
  const database = { query: async (_sql: string, values: string[][]) => {
    calls.push(values)
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: String(revision) })) }
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  return { database, calls, setRevision: (next: number) => { revision = next } }
}

test('authorized workspace readers share their earlier Team revisions despite different readiness', async () => {
  const f = workspaceRevisionFixture(), scope = { ownerId: owner, workspaceId: selectedTeam }
  await withReadBatchContext(async () => {
    for (const kind of ['thread_list', 'task_run_list', 'issue_list'] as const) {
      assert.deepEqual(await workspaceRevisions(f.database, [{ kind, id: selectedTeam }], scope), { [`${kind}:${selectedTeam}`]: 7 })
      f.setRevision(12)
    }
  }, workspacePlan)
  assert.deepEqual(f.calls, [[['issue_list', 'task_run_list', 'thread_list'], [selectedTeam, selectedTeam, selectedTeam]]])
  assert.deepEqual(await withReadBatchContext(() => workspaceRevisions(f.database, [{ kind: 'thread_list', id: selectedTeam }], scope), workspacePlan),
    { [`thread_list:${selectedTeam}`]: 12 })
  assert.equal(f.calls.length, 2, 'a later request observes current counters')
})

test('authorized Team plans do not resolve a Personal home or borrow a different workspace', async () => {
  const f = workspaceRevisionFixture(), peerTeam = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  await withReadBatchContext(async () => {
    const teamScope = { ownerId: owner, workspaceId: selectedTeam }
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'thread_list', id: selectedTeam }], teamScope), { [`thread_list:${selectedTeam}`]: 7 })
    f.setRevision(12)
    const home = { ownerId: owner, workspaceId: workspace }
    assert.deepEqual(await readBatchOwnerRevisions(f.database, [{ kind: 'issue_list', id: workspace }], home), { [`issue_list:${workspace}`]: 12 })
    const peer = { ownerId: 'other-owner', workspaceId: peerTeam }
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'thread_list', id: peerTeam }], peer), { [`thread_list:${peerTeam}`]: 12 })
  }, workspacePlan)
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.calls.map(call => [...new Set(call[1])]), [[selectedTeam], [workspace], [peerTeam]])
})

test('entities, unresolved scopes and mismatched workspace refs never start a Team plan', async () => {
  const f = workspaceRevisionFixture(), scope = { ownerId: owner, workspaceId: selectedTeam }
  await withReadBatchContext(async () => {
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'bot_chat', id: selectedTeam }], scope), { [`bot_chat:${selectedTeam}`]: 7 })
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'thread_list', id: workspace }], scope), { [threadKey]: 7 })
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'issue_list', id: workspace }], null), { [`issue_list:${workspace}`]: 7 })
    assert.deepEqual(await workspaceRevisions(f.database, [{ kind: 'thread_list', id: 'invalid' }], scope), {})
  }, workspacePlan)
  assert.deepEqual(f.calls.map(call => call[0]), [['bot_chat'], ['thread_list'], ['issue_list']])
})

test('workspace revision observations use the actual executor behind one request proxy', async () => {
  const first = workspaceRevisionFixture(7), second = workspaceRevisionFixture(12)
  const executors = new AsyncLocalStorage<Parameters<typeof readBatchRevisions>[0]>()
  const proxy = {
    get [COMMIT_EXECUTOR]() { return executors.getStore() },
    query(...args: unknown[]) { return Reflect.apply(executors.getStore()!.query, executors.getStore(), args) },
  } as unknown as Parameters<typeof readBatchRevisions>[0]
  const scope = { ownerId: owner, workspaceId: selectedTeam }, refs = [{ kind: 'thread_list' as const, id: selectedTeam }]
  await withReadBatchContext(async () => {
    assert.deepEqual(await executors.run(first.database, () => workspaceRevisions(proxy, refs, scope)), { [`thread_list:${selectedTeam}`]: 7 })
    assert.deepEqual(await executors.run(second.database, () => workspaceRevisions(proxy, refs, scope)), { [`thread_list:${selectedTeam}`]: 12 })
    assert.deepEqual(await executors.run(first.database, () => workspaceRevisions(proxy, refs, scope)), { [`thread_list:${selectedTeam}`]: 7 })
  }, workspacePlan)
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 1)
})

test('workspace plans never supply foreground revisions to after, cron or workflow reads', async () => {
  const f = workspaceRevisionFixture(), scope = { ownerId: owner, workspaceId: selectedTeam }
  const read = () => workspaceRevisions(f.database, [{ kind: 'thread_list', id: selectedTeam }], scope)
  await withReadBatchContext(async () => {
    assert.deepEqual(await read(), { [`thread_list:${selectedTeam}`]: 7 })
    let revision = 8
    for (const route of ['after:revision-fixture', 'cron:revision-fixture', 'workflow:revision-fixture/read']) {
      f.setRevision(revision)
      assert.deepEqual(await routeScope.run(route, read), { [`thread_list:${selectedTeam}`]: revision })
      revision++
    }
    assert.deepEqual(await read(), { [`thread_list:${selectedTeam}`]: 7 })
  }, workspacePlan)
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.slice(1).every(call => call[0].length === 1), 'deferred work does not inherit the plan either')
})

test('workspace plan failure and completed lifetimes never fabricate or retain revision proof', async () => {
  const failure = new Error('synthetic_workspace_revision_failure'), f = workspaceRevisionFixture()
  let unavailable = true, after!: () => Promise<unknown>, reads = 0
  const database = { query: async (...args: unknown[]) => {
    reads++
    if (unavailable) throw failure
    return Reflect.apply(f.database.query, f.database, args)
  } } as unknown as Parameters<typeof readBatchRevisions>[0]
  const scope = { ownerId: owner, workspaceId: selectedTeam }, refs = [{ kind: 'thread_list' as const, id: selectedTeam }]
  await assert.rejects(withReadBatchContext(async () => {
    after = AsyncLocalStorage.bind(() => workspaceRevisions(database, refs, scope))
    await workspaceRevisions(database, refs, scope)
  }, workspacePlan), error => error === failure)
  unavailable = false
  assert.deepEqual(await after(), { [`thread_list:${selectedTeam}`]: 7 })
  f.setRevision(12)
  assert.deepEqual(await after(), { [`thread_list:${selectedTeam}`]: 12 })
  assert.equal(reads, 3)
  assert.ok(f.calls.every(call => call[0].length === 1), 'the expired plan does not survive through a bound callback')
})

test('authorized Team list prefetch reduces three separately ready fixed-revision reads to one SQL', async () => {
  const f = workspaceRevisionFixture(7), scope = { ownerId: owner, workspaceId: selectedTeam }
  const kinds = ['thread_list', 'task_run_list', 'issue_list'] as const
  const observed: Record<string, number>[] = []
  await withReadBatchContext(async () => {
    for (const kind of kinds) {
      await Promise.resolve()
      observed.push(await workspaceRevisions(f.database, [{ kind, id: selectedTeam }], scope))
    }
  }, workspacePlan)
  assert.deepEqual(observed, kinds.map(kind => ({ [`${kind}:${selectedTeam}`]: 7 })),
    'all three readers finish with the same counters and only their original requested key')
  assert.equal(f.calls.length, 1, 'the old per-reader queue issues three SQL reads after separate readiness')
  assert.deepEqual(f.calls[0], [['issue_list', 'task_run_list', 'thread_list'], [selectedTeam, selectedTeam, selectedTeam]])
})

type ChoiceReadInput = Parameters<typeof readPendingWorkspaceChoices>[0]
const choiceFamily = {}, choiceRequest = {}, choiceDatabase = {}
const choiceInput = (patch: Partial<ChoiceReadInput> = {}): ChoiceReadInput => ({
  family: choiceFamily, database: choiceDatabase, request: choiceRequest, transaction: false,
  identity: { userId: owner, nativeSessionId: 'choice-native-session', requestedId: workspace }, ...patch,
})
const choiceRow = () => ({ id: workspace, name: 'Fixture', kind: 'team', role: 'member', organizationId: null })

test('pending workspace choices share one fresh SELECT and independent scalar rows before dispatch', async () => {
  let reads = 0
  const selected = choiceRow()
  const read = async () => { reads++; return [selected] }
  const result = await withReadBatchContext(() => Promise.all([
    readPendingWorkspaceChoices(choiceInput(), read),
    readPendingWorkspaceChoices(choiceInput(), read),
  ]))
  assert.equal(reads, 1)
  assert.deepEqual(result, [[choiceRow()], [choiceRow()]])
  assert.notEqual(result[0], result[1])
  assert.notEqual(result[0][0], result[1][0])
  result[0][0].name = 'Changed by one consumer'
  assert.equal(result[1][0].name, 'Fixture')
  assert.equal(selected.name, 'Fixture', 'a consumer cannot mutate the shared SQL observation')
})

test('a workspace SELECT is removed before callback construction and Drizzle thenable assimilation', async () => {
  for (const point of ['construction', 'then'] as const) {
    let reads = 0, following: Promise<ReturnType<typeof choiceRow>[]> | undefined
    const fresh = () => { reads++; return Promise.resolve([]) }
    const first = () => {
      reads++
      if (point === 'construction') following = readPendingWorkspaceChoices(choiceInput(), fresh)
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Match Drizzle query builders to test dispatch cleanup before assimilation.
        then(resolve: (rows: ReturnType<typeof choiceRow>[]) => void) {
          if (point === 'then') following = readPendingWorkspaceChoices(choiceInput(), fresh)
          resolve([choiceRow()])
        },
      } as PromiseLike<ReturnType<typeof choiceRow>[]>
    }
    await withReadBatchContext(async () => {
      assert.deepEqual(await readPendingWorkspaceChoices(choiceInput(), first), [choiceRow()])
      assert.ok(following)
      assert.deepEqual(await following, [], 'a call after the dispatch fence cannot join the older SELECT')
    })
    assert.equal(reads, 2, point)
  }
})

test('a later workspace read cannot join an in-flight or completed pre-revocation SELECT', async () => {
  let reads = 0, member = true, release!: () => void, dispatched!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { dispatched = resolve })
  const read = async () => {
    const rows = member ? [choiceRow()] : []
    if (++reads === 1) { dispatched(); await held }
    return rows
  }
  await withReadBatchContext(async () => {
    const earlier = readPendingWorkspaceChoices(choiceInput(), read)
    await started
    member = false
    assert.deepEqual(await readPendingWorkspaceChoices(choiceInput(), read), [])
    assert.equal(reads, 2, 'the old SQL remains unresolved while the revocation is observed')
    release()
    assert.deepEqual(await earlier, [choiceRow()])
    assert.deepEqual(await readPendingWorkspaceChoices(choiceInput(), read), [])
    assert.equal(reads, 3, 'completion is not a reusable authority cache')
    member = true
    assert.deepEqual(await readPendingWorkspaceChoices(choiceInput(), read), [choiceRow()])
    assert.equal(reads, 4, 'the same batch also sees restoration')
  })
})

test('workspace queue failures reject only their joined readers and never poison a later read', async () => {
  for (const synchronous of [true, false]) {
    let reads = 0
    const error = new Error('workspace SELECT unavailable')
    const failed = () => { reads++; if (synchronous) throw error; return Promise.reject(error) }
    await withReadBatchContext(async () => {
      const results = await Promise.allSettled([
        readPendingWorkspaceChoices(choiceInput(), failed),
        readPendingWorkspaceChoices(choiceInput(), failed),
      ])
      assert.ok(results.every(result => result.status === 'rejected' && result.reason === error))
      assert.equal(reads, 1)
      assert.deepEqual(await readPendingWorkspaceChoices(choiceInput(), async () => { reads++; return [choiceRow()] }), [choiceRow()])
      assert.equal(reads, 2)
    })
  }
})

test('workspace choices are partitioned by request, SQL family, executor, session, reader, pin and principal', async () => {
  const base = choiceInput()
  const identities: ChoiceReadInput['identity'][] = [
    { ...base.identity, userId: 'other-owner' },
    { ...base.identity, nativeSessionId: 'another-session' },
    { ...base.identity, requestedId: 'another-workspace' },
    { ...base.identity, tokenWorkspaceId: 'pinned-workspace' },
    { ...base.identity, principal: { kind: 'session', sessionId: 'explicit-session' } },
    { ...base.identity, principal: { kind: 'pat', tokenId: 'pat-a', workspaceId: workspace } },
    { ...base.identity, principal: { kind: 'pat', tokenId: 'pat-b', workspaceId: workspace } },
    { ...base.identity, principal: { kind: 'delegation', credentialId: 'delegation', credentialKind: 'oauth' } },
    { ...base.identity, principal: { kind: 'delegation', credentialId: 'delegation', credentialKind: 'run' } },
    { ...base.identity, principal: { kind: 'delegation', credentialId: 'delegation', credentialKind: 'run', workspaceId: workspace } },
    { ...base.identity, principal: { kind: 'admission', runId: 'run-a', workspaceId: workspace } },
    { ...base.identity, principal: { kind: 'admission', runId: 'run-b', workspaceId: workspace } },
    { ...base.identity, acting: { userId: owner } },
    { ...base.identity, acting: { userId: 'other-acting-user' } },
    { ...base.identity, acting: { userId: owner, tokenWorkspaceId: workspace } },
    { ...base.identity, acting: { userId: owner, enterprisePrincipal: { kind: 'session', sessionId: 'acting-session' } } },
  ]
  const inputs = [base, choiceInput({ request: {} }), choiceInput({ family: {} }), choiceInput({ database: {} }),
    ...identities.map(identity => choiceInput({ identity }))]
  let reads = 0
  await withReadBatchContext(() => Promise.all(inputs.flatMap(input => [
    readPendingWorkspaceChoices(input, async () => { reads++; return [choiceRow()] }),
    readPendingWorkspaceChoices(input, async () => { reads++; return [choiceRow()] }),
  ])))
  assert.equal(reads, inputs.length, 'only each exact pair shares its own new SELECT')
  const execution = new AsyncLocalStorage<object>()
  const proxy = new Proxy({}, { get: (_target, property) => property === COMMIT_EXECUTOR ? execution.getStore() : undefined })
  await withReadBatchContext(() => Promise.all([{}, {}].map(executor => execution.run(executor, () =>
    readPendingWorkspaceChoices(choiceInput({ database: proxy }), async () => { reads++; return [] })))))
  assert.equal(reads, inputs.length + 2, 'one dynamic pool proxy cannot merge different actual executors')
})

test('transactions, absent Native identity, unknown principal and detached work bypass the workspace queue', async () => {
  const base = choiceInput()
  const unsupported = { kind: 'future-principal' } as unknown as NonNullable<ChoiceReadInput['identity']['principal']>
  const extended = { kind: 'session', sessionId: 'session', futureAssurance: 'unknown' } as NonNullable<ChoiceReadInput['identity']['principal']>
  const inputs = [
    choiceInput({ transaction: true }), choiceInput({ request: undefined }),
    choiceInput({ identity: { ...base.identity, nativeSessionId: undefined } }),
    choiceInput({ identity: { ...base.identity, principal: unsupported } }),
    choiceInput({ identity: { ...base.identity, principal: extended } }),
    choiceInput({ identity: { ...base.identity, acting: { userId: owner, enterprisePrincipal: unsupported } } }),
  ]
  let reads = 0
  const read = async () => { reads++; return [choiceRow()] }
  for (const input of inputs) await withReadBatchContext(() => Promise.all([
    readPendingWorkspaceChoices(input, read), readPendingWorkspaceChoices(input, read),
  ]))
  assert.equal(reads, inputs.length * 2)
  let later!: () => Promise<ReturnType<typeof choiceRow>[][]>
  const after = () => Promise.all([readPendingWorkspaceChoices(base, read), readPendingWorkspaceChoices(base, read)])
  await assert.rejects(withReadBatchContext(async () => {
    later = AsyncLocalStorage.bind(after)
    throw new Error('batch stopped before its later callback')
  }), /batch stopped/)
  await later()
  assert.equal(reads, inputs.length * 2 + 2, 'a bound callback cannot reactivate the closed queue')
  for (const route of ['after:fixture', 'cron:fixture', 'workflow:fixture']) {
    await withReadBatchContext(() => routeScope.run(route, after))
  }
  assert.equal(reads, inputs.length * 2 + 8)
})

test('parallel and successive Native batches never share a workspace observation', async () => {
  let reads = 0
  const read = async () => { reads++; return [choiceRow()] }
  const run = () => withReadBatchContext(() => Promise.all([
    readPendingWorkspaceChoices(choiceInput(), read), readPendingWorkspaceChoices(choiceInput(), read),
  ]))
  await Promise.all([run(), run()])
  assert.equal(reads, 2)
  await run()
  assert.equal(reads, 3)
  await Promise.all([readPendingWorkspaceChoices(choiceInput(), read), readPendingWorkspaceChoices(choiceInput(), read)])
  assert.equal(reads, 5, 'ordinary reads outside Native batching always execute their own SELECT')
})
