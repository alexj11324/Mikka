import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
const results = []

async function runtime(variant) {
  const [fixture, batch, tasks, summaries, issues, revisions] = await Promise.all([
    import(`./${variant}/fixture.mjs`), import(`./${variant}/lib/desktop-rpc/read-batch.mjs`),
    import(`./${variant}/app/actions/task-runs.mjs`), import(`./${variant}/app/actions/coordinator.mjs`),
    import(`./${variant}/app/actions/issues.mjs`), import(`./${variant}/lib/live/revisions.mjs`),
  ])
  // Warm only copied modules, as on an already running server. No I/O backend exists.
  await Promise.all([import(`./${variant}/lib/db/request-scope.mjs`), import(`./${variant}/lib/workspace-db.mjs`), import(`./${variant}/lib/live/owner-scope.mjs`)])
  const methods = { 'task-runs.pollTaskRuns': tasks.pollTaskRuns, 'task-runs.syncThreadList': tasks.syncThreadList,
    'coordinator.pollBotChatSummaries': summaries.pollBotChatSummaries, 'issues.syncIssueList': issues.syncIssueList,
    'teams.listTeams': async () => [] }
  const actions = Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, {
    args: { safeParse: args => Array.isArray(args) && args.length === 0 ? { success: true, data: args } : { success: false } },
    invoke: args => method(...args),
  }]))
  const invoke = batch.createReadBatch(() => actions)
  return { ...fixture, ...revisions, invoke: (state, names) => fixture.fixture.run(state, () => invoke(names.map(action => ({ action, args: [] })))) }
}
const runtimes = { baseline: await runtime('baseline'), prototype: await runtime('prototype') }
const actions = [...runtimes.baseline.earlyActions, 'issues.syncIssueList']
function withoutRevisions(value) { return JSON.parse(JSON.stringify(value, (key, value) => key === 'revisions' ? undefined : value)) }
async function exercise(variant, options = {}, beforeIssue) {
  const runtime = runtimes[variant], state = runtime.makeFixture({ deferWorkspace: true, ...options })
  const pending = runtime.invoke(state, actions)
  await state.earlyDone.promise
  if (beforeIssue) beforeIssue(state)
  state.workspaceGate.resolve()
  const items = await pending
  return { state, items }
}
function save(name, measurements) {
  const row = { name, ...measurements }; results.push(row); console.log(`RECEIPT ${JSON.stringify(row)}`)
}

test('actual four action bodies: delayed authorized workspace context splits owner revisions 2 -> 1', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline'), prototype = await exercise('prototype')
  assert.deepEqual(prototype.items, baseline.items)
  assert.ok(baseline.items.every(item => item.ok))
  assert.equal(baseline.state.revisionQueries.length, 2)
  assert.equal(prototype.state.revisionQueries.length, 1)
  for (const sample of [baseline, prototype]) {
    assert.equal(sample.state.events.filter(event => event.event === 'owner_scope_query').length, 1)
    for (const [index, name] of actions.entries()) {
      const result = sample.items[index].result, live = result.live ?? result.snapshot.live
      const kind = { 'task-runs.pollTaskRuns': 'task_run_list', 'task-runs.syncThreadList': 'thread_list', 'coordinator.pollBotChatSummaries': 'bot_chat_list', 'issues.syncIssueList': 'issue_list' }[name]
      assert.deepEqual(Object.keys(live.revisions), [`${kind}:${sample.state.home}`], 'one reader receives only its original key')
      const observed = sample.state.events.findIndex(event => event.event === 'revision_observed' && event.kinds.includes(kind))
      const data = sample.state.events.findIndex(event => event.action === name && event.event.startsWith('business_'))
      assert.ok(observed >= 0 && data > observed, `revision before original ${name} data`)
    }
  }
  save('personal_scope_staggered', { baselineQueries: baseline.state.revisionQueries, prototypeQueries: prototype.state.revisionQueries,
    ownerScopeQueriesEach: 1, outputEqual: true, perReaderRefsUnchanged: true, baselineEvents: baseline.state.events, prototypeEvents: prototype.state.events })
})

test('ordinary immediate dependency completion is measured separately', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline', { deferWorkspace: false }), prototype = await exercise('prototype', { deferWorkspace: false })
  assert.deepEqual(prototype.items, baseline.items)
  assert.ok(prototype.state.revisionQueries.length <= baseline.state.revisionQueries.length)
  save('personal_scope_immediate', { baselineQueries: baseline.state.revisionQueries, prototypeQueries: prototype.state.revisionQueries, outputEqual: true })
})

test('selected team id is read only after original workspace resolution; no claimed query saving', { timeout: 5000 }, async () => {
  const selected = runtimes.baseline.team
  const baseline = await exercise('baseline', { selected }), prototype = await exercise('prototype', { selected })
  assert.deepEqual(prototype.items, baseline.items)
  assert.equal(baseline.state.revisionQueries.length, 2)
  assert.equal(prototype.state.revisionQueries.length, 2)
  assert.ok(prototype.state.revisionQueries[0].ids.every(id => id === prototype.state.home))
  assert.deepEqual(prototype.state.revisionQueries[1].ids, [selected])
  save('selected_team_no_saving', { baselineQueries: baseline.state.revisionQueries, prototypeQueries: prototype.state.revisionQueries, outputEqual: true })
})

test('a concurrent revision increase remains conservatively old, with identical business items/version', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline', {}, state => { state.revision = 12 })
  const prototype = await exercise('prototype', {}, state => { state.revision = 12 })
  assert.deepEqual(withoutRevisions(prototype.items), withoutRevisions(baseline.items))
  const lateBaseline = baseline.items[3].result.snapshot, latePrototype = prototype.items[3].result.snapshot
  const key = `issue_list:${prototype.state.home}`
  assert.equal(lateBaseline.live.revisions[key], 12)
  assert.equal(latePrototype.live.revisions[key], 7)
  assert.equal(runtimes.prototype.coversLiveRevisions(latePrototype, { [key]: 12 }), false)
  const next = runtimes.prototype.makeFixture({ revision: 12 })
  const nextItems = await runtimes.prototype.invoke(next, ['issues.syncIssueList'])
  assert.equal(nextItems[0].result.snapshot.live.revisions[key], 12)
  save('concurrent_write', { baselineIssueRevision: 12, prototypeIssueRevision: 7, unseenPushAcknowledged: false,
    nextBatchIssueRevision: 12, businessItemsAndVersionEqual: true })
})

test('one-action and non-revision actions do not issue speculative revision SQL', { timeout: 5000 }, async () => {
  const rows = []
  for (const name of [...actions, 'teams.listTeams']) {
    const measurements = []
    for (const variant of ['baseline', 'prototype']) {
      const runtime = runtimes[variant], state = runtime.makeFixture()
      const items = await runtime.invoke(state, [name])
      assert.ok(items[0].ok)
      const expected = name === 'teams.listTeams' ? 0 : 1
      assert.equal(state.revisionQueries.length, expected)
      if (expected) assert.equal(state.revisionQueries[0].kinds.length, 1)
      measurements.push({ variant, queries: state.revisionQueries.length, items })
    }
    assert.deepEqual(measurements[0].items, measurements[1].items)
    rows.push({ name, queriesEach: measurements[0].queries, outputEqual: true })
  }
  save('single_and_non_revision', { rows })
})

test('failed authentication issues no owner or revision SQL', { timeout: 5000 }, async () => {
  for (const variant of ['baseline', 'prototype']) {
    const runtime = runtimes[variant], state = runtime.makeFixture({ authenticated: false })
    await assert.rejects(runtime.invoke(state, actions), error => error.code === 'authRequired')
    assert.equal(state.revisionQueries.length, 0)
    assert.equal(state.events.filter(event => event.event === 'owner_scope_query').length, 0)
  }
  save('revoked_authentication_fixture', { ownerQueriesEach: 0, revisionQueriesEach: 0, authRequiredPreserved: true })
})

test('missing personal home does not invent a scope or prefetch keys', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline', { homeAvailable: false, selected: runtimes.baseline.team })
  const prototype = await exercise('prototype', { homeAvailable: false, selected: runtimes.baseline.team })
  assert.deepEqual(prototype.items, baseline.items)
  for (const sample of [baseline, prototype]) {
    assert.equal(sample.state.revisionQueries.length, 1)
    assert.deepEqual(sample.state.revisionQueries[0].kinds, ['issue_list'])
    assert.deepEqual(sample.state.revisionQueries[0].ids, [sample.state.selected])
  }
  save('missing_home', { queriesEach: 1, onlyOriginalSelectedIssueKey: true, outputEqual: true })
})

test('reader access failure preserves items and does not add a SQL statement', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline', { workspaceError: true }), prototype = await exercise('prototype', { workspaceError: true })
  assert.deepEqual(prototype.items, baseline.items)
  assert.equal(prototype.items[3].result.error, 'workspaceAccessDenied')
  assert.equal(baseline.state.revisionQueries.length, 1)
  assert.equal(prototype.state.revisionQueries.length, 1)
  save('late_reader_denied', { queriesEach: 1, outputEqual: true, limitation: 'Closed prepared plan includes one issue_list key whose later reader fails authorization; no extra statement or response key, but one extra safe metadata key is requested.' })
})

test('revision failure never fabricates proof; expanded failure affects best-effort metadata only', { timeout: 5000 }, async () => {
  const baseline = await exercise('baseline', { failRevisionOnce: true }), prototype = await exercise('prototype', { failRevisionOnce: true })
  assert.deepEqual(withoutRevisions(prototype.items), withoutRevisions(baseline.items))
  assert.equal(baseline.items[3].result.snapshot.live.revisions[`issue_list:${baseline.state.home}`], 7)
  assert.equal(prototype.items[3].result.snapshot.live.revisions, undefined)
  const next = runtimes.prototype.makeFixture()
  const nextItems = await runtimes.prototype.invoke(next, ['issues.syncIssueList'])
  assert.equal(nextItems[0].result.snapshot.live.revisions[`issue_list:${next.home}`], 7)
  save('revision_failure', { baselineQueries: baseline.state.revisionQueries.length, prototypeQueries: prototype.state.revisionQueries.length,
    businessItemsAndVersionEqual: true, fabricatedRevision: false, nextRequestRecovers: true,
    limitation: 'Prefetched issue key shares the failed early query instead of making the late baseline query; it lacks revision proof until a later read.' })
})

test('parallel batches and different owners remain isolated', { timeout: 5000 }, async () => {
  const runtime = runtimes.prototype
  const a = runtime.makeFixture(), b = runtime.makeFixture({ owner: runtime.team, home: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', selected: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 12 })
  const [left, right] = await Promise.all([runtime.invoke(a, actions), runtime.invoke(b, actions)])
  assert.ok(left.every(item => item.ok) && right.every(item => item.ok))
  assert.equal(a.revisionQueries.length, 1); assert.equal(b.revisionQueries.length, 1)
  assert.ok(a.revisionQueries[0].ids.every(id => id === a.home))
  assert.ok(b.revisionQueries[0].ids.every(id => id === b.home))
  save('parallel_owners', { queriesPerBatch: 1, scopeIsolation: true, revisionA: 7, revisionB: 12 })
})

test.after(async () => {
  await writeFile(`${root}/measurements.safe.json`, JSON.stringify({ kind: 'controlled-source-copy-measurement', actualNativeFrequency: 'unknown_no_batch_item_mapping_in_old_artifact', realModelCalls: 0, productionQueries: 0, results }, null, 2) + '\n')
})
