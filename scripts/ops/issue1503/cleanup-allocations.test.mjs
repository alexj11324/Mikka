import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadAllocationScope, allocationTargets, allocationIdentity, findLegacyCreated,
  confirmAllocationAbsence, assertAllocationPostcondition, PINNED_HISTORY,
  loadFailedAllocationScope, FAILED_RELEASE_HISTORY, FAILED_RELEASE_INPUTS } from './cleanup-allocations.mjs'

const fixture = JSON.parse(await readFile(new URL('./cleanup-allocation-scope.json', import.meta.url), 'utf8'))
const clone = value => structuredClone(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = fixture.smokeUserId
const WORKSPACE = fixture.workspaceId

function inputs() {
  const config = clone(fixture)
  const files = new Map()
  for (const [index, harness] of ['claude_code', 'codex'].entries()) {
    const start = 100 + index * 10
    const origin = id(start), review = id(start + 1), repair = id(start + 2), child = id(start + 3)
    const evidence = [{ runId: review }]
    const candidate = runId => ({ runId, reviewArtifacts: evidence, verification: evidence, checks: evidence })
    const item = { harness, status: 'passed', issueId: id(start + 4), taskId: id(start + 5),
      threadRunId: origin, creation: { runId: origin }, dispatchReceipts: { runIds: [origin] },
      runIdsSeen: [origin, review, repair, ...(index ? [child] : [])],
      runs: [{ runId: origin }, { runId: review }, { runId: repair }],
      initial: candidate(index ? child : origin), repaired: candidate(repair),
      merge: { source: 'mikka', mergeCommitSha: 'b'.repeat(40) } }
    if (index) item.questionConfirmation = { required: true, answerAttempted: true, resolved: true,
      origin: { runId: origin }, continuation: { runId: child },
      receipt: { source: 'normal_factory_question_api', originRunId: origin, continuationRunId: child } }
    const raw = { issue: 1503, phase: 'delivery', status: 'passed', workspaceId: WORKSPACE,
      teamId: '62a760fc-da79-4d50-a8fa-a818e25d2f9a', repository: 'alexj11324/Mikka-handoff',
      expectedSha: 'a'.repeat(40), marker: 'offline-only-test', selectedHarnesses: [harness],
      startedAt: `2026-11-07T10:${index ? '20' : '00'}:00.000Z`,
      completedAt: `2026-11-07T10:${index ? '30' : '10'}:00.000Z`, cases: [item] }
    const bytes = Buffer.from(JSON.stringify(raw))
    config.passedReports[index] = { harness, path: `${harness}.json`, sha256: digest(bytes) }
    files.set(`${harness}.json`, bytes)
  }
  files.set('latest.json', files.get('codex.json'))
  return { config, files, read: async path => {
    assert.ok(files.has(path), 'unexpected fixture read'); return files.get(path)
  } }
}
async function state() {
  const input = inputs()
  const scope = await loadAllocationScope(input.config, 'latest.json', input.read)
  const tasks = [...new Map(scope.allocations.map(item => [item.taskId,
    { id: item.taskId, issueId: item.issueId, userId: OWNER, stage: 'publish', status: 'passed' }])).values()]
  const threads = scope.allocations.map((item, index) => ({
    runId: item.runId, ownerId: OWNER, workspaceId: WORKSPACE, issueId: item.issueId,
    operationId: item.operationId ?? id(200 + index), phase: index === 0 ? null : 'retired',
    sandboxId: null, state: 'ended', pending: false, runOwnerId: OWNER, runIssueId: item.issueId,
    runStatus: 'succeeded', runFinishedAt: index === 0 ? '2026-11-06T19:56:45.867476+00:00' : '2026-11-07T10:30:00.000Z',
    runLeaseLive: false, legacyTerminalAtMatches: index === 0,
  }))
  const inventory = { tasks, threads, runs: [], subagents: [], clouds: [], other_sandboxes: [],
    global_activity: { activeOrQueuedRuns: 0, pendingFactoryWork: 0, pendingThreadProvisioning: 0,
      pendingCloudProvisioning: 0, liveWorkerLeases: 0, unfinishedSubagents: 0, pendingSandboxKills: 0 } }
  scope.allocations = allocationIdentity(allocationTargets(scope, inventory))
  return { scope, inventory }
}
function providers(found = null) {
  const events = []
  return { events,
    legacy: async target => { events.push(['legacy', target.runId]); return target.runId === PINNED_HISTORY[0].runId ? found : null },
    modern: async (...args) => { events.push(['modern', ...args]); return null },
    kill: async (...args) => { events.push(['kill', ...args]) },
    info: async (...args) => { events.push(['info', ...args]); return { state: 'missing', endAt: null } },
  }
}
async function finish(scope, inventory, provider, after = inventory) {
  let restores = 0
  const receipts = [], confirmed = new Set()
  const identity = await confirmAllocationAbsence(scope, inventory, provider, confirmed, item => receipts.push(item))
  assertAllocationPostcondition(scope, after, identity, confirmed)
  restores++
  return { restores, receipts, confirmed }
}

test('null future reports remain non-executable before any raw read', async () => {
  let reads = 0
  await assert.rejects(loadAllocationScope(fixture, 'latest.json', async () => { reads++; return Buffer.from('{}') }),
    /passed_inputs_missing/)
  assert.equal(reads, 0)
})

test('actual raw hashes, single-harness success, chronological latest and continuation closure are required', async () => {
  const input = inputs()
  const scope = await loadAllocationScope(input.config, 'latest.json', input.read)
  assert.equal(scope.allocations.length, 24)
  for (const n of [110, 111, 112, 113]) assert.ok(scope.allocations.some(item => item.runId === id(n)))
  const changed = inputs(); changed.files.set('claude_code.json', Buffer.from('{}'))
  await assert.rejects(loadAllocationScope(changed.config, 'latest.json', changed.read), /passed_raw_sha_mismatch/)
  const stale = inputs(); stale.files.set('latest.json', stale.files.get('claude_code.json'))
  await assert.rejects(loadAllocationScope(stale.config, 'latest.json', stale.read), /latest_passed_not_chronological/)
  const failed = inputs()
  const raw = JSON.parse(failed.files.get('codex.json')); raw.status = 'failed'
  const bytes = Buffer.from(JSON.stringify(raw)); failed.files.set('codex.json', bytes)
  failed.config.passedReports[1].sha256 = digest(bytes)
  await assert.rejects(loadAllocationScope(failed.config, 'latest.json', failed.read), /passed_report_scope/)
})

test('legacy three-key lookup finds the original VM after adoption; no operation filter and no connect', async () => {
  const { scope, inventory } = await state()
  const target = allocationTargets(scope, inventory).find(item => item.runId === PINNED_HISTORY[0].runId)
  const metadata = { application: 'mikka-thread', workspaceId: WORKSPACE, runId: target.runId }
  const vm = { sandboxId: 'old-owned-vm', state: 'paused', metadata }
  const events = []
  const found = await findLegacyCreated(target, {
    options: async owner => { assert.equal(owner, OWNER); return { requestTimeoutMs: 15000, apiKey: 'offline-only' } },
    list: options => {
      events.push(options); assert.deepEqual(options.query.metadata, metadata)
      assert.deepEqual(options.query.state, ['running', 'paused']); assert.equal(options.limit, 2)
      assert.equal('operationId' in options.query.metadata, false)
      return { hasNext: false, nextItems: async () => [vm] }
    },
  })
  assert.deepEqual(found, { sandboxId: vm.sandboxId, state: 'paused' })
  assert.equal(events.length, 1)
  // The adopted run is separately scoped, so querying it cannot hide the old metadata owner.
  assert.ok(scope.allocations.some(item => item.runId === PINNED_HISTORY[1].runId
    && item.taskId === target.taskId && item.issueId === target.issueId))
})

test('legacy tuple drift, pagination, multiple results and metadata mismatch never authorize a kill', async t => {
  const { scope, inventory } = await state()
  const target = allocationTargets(scope, inventory).find(item => item.lookup === 'legacy_run_metadata')
  let credentialReads = 0
  await assert.rejects(findLegacyCreated({ ...target, operationId: id(998) }, {
    options: async () => { credentialReads++; return {} }, list: () => { throw new Error('must not list') },
  }), /legacy_target_not_pinned/)
  assert.equal(credentialReads, 0)
  const vm = { sandboxId: 'old-vm', state: 'running',
    metadata: { application: 'mikka-thread', workspaceId: WORKSPACE, runId: target.runId } }
  for (const [name, values, hasNext] of [['multiple', [vm, vm], false], ['pagination', [], true],
    ['wrong metadata', [{ ...vm, metadata: { ...vm.metadata, runId: id(999) } }], false]]) {
    await t.test(name, async () => {
      await assert.rejects(findLegacyCreated(target, { options: async () => ({}),
        list: () => ({ hasNext, nextItems: async () => values }) }), /legacy_allocation_identity_unavailable/)
    })
  }
})

test('all identity lookups precede own-only kill, then exact same ID missing; null stays a different receipt', async () => {
  const { scope, inventory } = await state()
  const provider = providers({ sandboxId: 'old-owned-vm', state: 'paused' })
  const result = await finish(scope, inventory, provider)
  assert.equal(result.restores, 1)
  const killIndex = provider.events.findIndex(item => item[0] === 'kill')
  assert.equal(killIndex, scope.allocations.length)
  assert.deepEqual(provider.events.slice(killIndex), [['kill', 'old-owned-vm', OWNER], ['info', 'old-owned-vm', OWNER]])
  for (const event of provider.events.filter(item => item[0] === 'modern')) {
    assert.equal(event.length, 5); assert.equal(event[2], WORKSPACE); assert.equal(event[4], OWNER)
    assert.match(event[3], /^[0-9a-f-]{36}$/)
  }
  assert.equal(result.receipts.filter(item => item.result === 'killed_and_exact_id_missing').length, 1)
  assert.equal(result.receipts.filter(item => item.result === 'no_matching_active_allocation').length, 23)
  assert.equal(result.receipts.filter(item => item.result === 'no_matching_active_allocation').some(item => 'sandboxId' in item), false)
})

test('whole own-workspace closure rejects cleared ended unknown/null-issue rows, missing runs and active work before provider calls', async t => {
  const variants = [
    ['different issue', s => s.threads.push({ ...s.threads[1], runId: id(900), issueId: id(901) })],
    ['null issue', s => s.threads.push({ ...s.threads[1], runId: id(900), issueId: null })],
    ['missing receipt run', s => s.threads.pop()],
    ['known row issue drift', s => { s.threads[1].issueId = null }],
    ['foreign run owner', s => { s.threads[1].runOwnerId = 'foreign' }],
    ['unscoped active run', s => { s.runs.push({ id: id(900), userId: OWNER }) }],
    ['global activity', s => { s.global_activity.liveWorkerLeases = 1 }],
  ]
  for (const [name, change] of variants) await t.test(name, async () => {
    const { scope, inventory } = await state(); change(inventory)
    const provider = providers()
    await assert.rejects(finish(scope, inventory, provider), /issue1503_cleanup_/)
    assert.deepEqual(provider.events, [])
  })
})

test('only the fixed 9f tuple may have NULLphase, and only with its exact successful timestamp equality', async t => {
  for (const [name, change] of [
    ['other null phase', s => { s.threads[1].phase = null }],
    ['wrong operation', s => { s.threads[0].operationId = id(700) }],
    ['different terminal instant', s => { s.threads[0].legacyTerminalAtMatches = false }],
    ['failed instead of succeeded', s => { s.threads[0].runStatus = 'failed' }],
  ]) await t.test(name, async () => {
    const { scope, inventory } = await state(); change(inventory)
    const provider = providers()
    await assert.rejects(finish(scope, inventory, provider), /issue1503_cleanup_/)
    assert.deepEqual(provider.events, [])
  })
})

test('unknown provider results or holder conflicts retain credentials; transport errors never become missing', async t => {
  for (const [name, alter] of [
    ['modern unknown', p => { p.modern = async () => ({ state: 'unknown' }) }],
    ['modern ambiguity', p => { p.modern = async () => { throw new Error('normal-provider-identity-unavailable') } }],
    ['GET present', p => { p.info = async () => ({ state: 'running' }) }],
    ['GET transport error', p => { p.info = async () => { throw new Error('transport') } }],
  ]) await t.test(name, async () => {
    const { scope, inventory } = await state()
    const provider = providers({ sandboxId: 'owned-vm', state: 'running' }); alter(provider)
    await assert.rejects(finish(scope, inventory, provider))
    if (name.startsWith('modern')) assert.equal(provider.events.some(item => item[0] === 'kill'), false)
  })
  const { scope, inventory } = await state()
  inventory.other_sandboxes.push({ workspaceId: id(999), sandboxId: 'moved-vm' })
  const provider = providers({ sandboxId: 'moved-vm', state: 'running' })
  await assert.rejects(finish(scope, inventory, provider), /allocation_other_workspace_holder/)
  assert.equal(provider.events.some(item => item[0] === 'kill'), false)
})

test('already-scheduled post inventory rejects a new cleared row or operation drift before restoration', async t => {
  for (const [name, change] of [
    ['extra ended row', s => s.threads.push({ ...s.threads[1], runId: id(900), issueId: id(901) })],
    ['operation changed', s => { s.threads.at(-1).operationId = id(901) }],
    ['new activity', s => { s.global_activity.pendingFactoryWork = 1 }],
  ]) await t.test(name, async () => {
    const { scope, inventory } = await state(); const after = clone(inventory); change(after)
    await assert.rejects(finish(scope, inventory, providers(), after), /issue1503_cleanup_/)
  })
})


// Historical UUIDs below are admitted identities. The inputs() cases and id()
// values are memory-only unit fixtures, never future production input pins.
const history17Digest = value => digest(Buffer.from(JSON.stringify(value, null, 2) + '\n'))
function history17Rewrite(input, index, change) {
  const entry = input.config.passedReports[index]
  const raw = JSON.parse(input.files.get(entry.path))
  change(raw)
  const bytes = Buffer.from(JSON.stringify(raw))
  input.files.set(entry.path, bytes)
  entry.sha256 = digest(bytes)
  if (index === 1) input.files.set('latest.json', bytes)
}

test('history17: admitted identities stay exact and failed history remains independently thirteen', () => {
  assert.equal(PINNED_HISTORY.length, 17)
  assert.equal(history17Digest(PINNED_HISTORY),
    'f14e717eda762a735a56a05918ac38049ec59b766b86b213a483cee94fb6ce4a')
  assert.deepEqual(fixture.historicalAllocations, PINNED_HISTORY)
  assert.equal(new Set(PINNED_HISTORY.map(item => item.runId)).size, 17)
  assert.ok(PINNED_HISTORY.every(item => typeof item.operationId === 'string'))
  assert.equal(FAILED_RELEASE_HISTORY.length, 13)
  assert.equal(history17Digest(FAILED_RELEASE_HISTORY),
    '282c896ff1c9f1b49ebb3668814bd5a752d8f9da6388554140c168659b5db50c')
  assert.deepEqual(fixture.failedHistoricalAllocations, FAILED_RELEASE_HISTORY)
  assert.deepEqual(PINNED_HISTORY.slice(0, 7), FAILED_RELEASE_HISTORY.slice(0, 7))
  assert.deepEqual(PINNED_HISTORY.map(item => item.lookup),
    [...Array(3).fill('legacy_run_metadata'), ...Array(14).fill('operation_metadata')])
})

test('history17: default final mode requires new passed cases beyond the complete history', async () => {
  const input = inputs()
  assert.equal(input.config.mode, 'failed_release') // This field belongs to the unchanged failed loader.
  const scope = await loadAllocationScope(input.config, 'latest.json', input.read)
  assert.equal(scope.mode, 'final_delivery')
  assert.equal(scope.allocations.length, 24)
  assert.deepEqual(scope.allocations.slice(0, 17), PINNED_HISTORY)
  for (const mode of ['final_delivery', undefined]) {
    const onlyHistory = { ...scope, mode, allocations: clone(PINNED_HISTORY) }
    assert.throws(() => allocationTargets(onlyHistory, {}), /allocation_scope_invalid/)
  }
  assert.throws(() => allocationTargets({ ...scope, mode: 'unknown_mode' }, {}),
    /allocation_scope_invalid/)
})

test('history17: complete history does not fill future receipt placeholders', async () => {
  let reads = 0
  assert.deepEqual(fixture.passedReports.map(item => [item.path, item.sha256]),
    [[null, null], [null, null]])
  await assert.rejects(loadAllocationScope(fixture, 'latest.json', async () => {
    reads++; throw new Error('must not read any unpinned future input')
  }), /passed_inputs_missing/)
  assert.equal(reads, 0)
})

test('history17: failed receipts and reused historical run IDs cannot authorize final PASS', async () => {
  const failed = inputs()
  history17Rewrite(failed, 1, raw => {
    raw.status = 'failed'
    raw.cases[0].status = 'failed'
  })
  await assert.rejects(loadAllocationScope(failed.config, 'latest.json', failed.read),
    /passed_report_scope/)
  const reused = inputs()
  history17Rewrite(reused, 0, raw => raw.cases[0].runIdsSeen.push(PINNED_HISTORY[10].runId))
  await assert.rejects(loadAllocationScope(reused.config, 'latest.json', reused.read),
    /allocation_run_overlap/)
})

test('history17: changed historical operations or duplicate old35c4 tuples fail before reads', async () => {
  for (const change of [
    config => { config.historicalAllocations[13].operationId = id(999) },
    config => { config.historicalAllocations.push(clone(config.historicalAllocations[10])) },
  ]) {
    const config = clone(fixture); change(config)
    let reads = 0
    await assert.rejects(loadAllocationScope(config, 'latest.json', async () => {
      reads++; throw new Error('must not read a mismatched scope')
    }), /allocation_scope_invalid/)
    assert.equal(reads, 0)
  }
})

test('history17: failed-source hashes, scope headers and stale latest sources remain rejected', async () => {
  const wrongHash = inputs()
  wrongHash.config.passedReports[0].sha256 = FAILED_RELEASE_INPUTS[0].sha256
  await assert.rejects(loadAllocationScope(wrongHash.config, 'latest.json', wrongHash.read),
    /passed_raw_sha_mismatch/)
  const wrongHeader = inputs()
  history17Rewrite(wrongHeader, 0, raw => { raw.workspaceId = id(998) })
  await assert.rejects(loadAllocationScope(wrongHeader.config, 'latest.json', wrongHeader.read),
    /passed_report_scope/)
  const stale = inputs(); stale.files.set('latest.json', stale.files.get('claude_code.json'))
  await assert.rejects(loadAllocationScope(stale.config, 'latest.json', stale.read),
    /latest_passed_not_chronological/)
})

test('history17: old failed mode retains its thirteen-plus-four identities and threshold', async () => {
  let reads = 0
  await assert.rejects(loadFailedAllocationScope(fixture, 'latest-failed.json', async () => {
    reads++; return Buffer.alloc(0)
  }), /failed_raw_sha_mismatch/)
  assert.equal(reads, 1) // Configuration reached the unchanged exact-original-byte guard.
  const allocations = [
    ...clone(FAILED_RELEASE_HISTORY),
    ...FAILED_RELEASE_INPUTS.flatMap(item => item.runIds.map(runId => ({
      issueId: item.issueId, taskId: item.taskId, runId, operationId: null, lookup: 'operation_metadata',
    }))),
  ]
  assert.equal(allocations.length, 17)
  const failed = { version: 1, ownerId: OWNER, workspaceId: WORKSPACE,
    mode: 'failed_release', acceptancePassed: false, allocations }
  const { inventory } = await state()
  const runs = new Set(allocations.map(item => item.runId))
  const tasks = new Set(allocations.map(item => item.taskId))
  inventory.threads = inventory.threads.filter(item => runs.has(item.runId))
  inventory.tasks = inventory.tasks.filter(item => tasks.has(item.id))
  const targets = allocationTargets(failed, inventory)
  assert.deepEqual(targets.map(({ issueId, taskId, runId, operationId, lookup }) =>
    ({ issueId, taskId, runId, operationId, lookup })), PINNED_HISTORY)
  assert.throws(() => allocationTargets({ ...failed, mode: 'final_delivery' }, inventory),
    /allocation_scope_invalid/)
})

test('history17: newly bound operation IDs remain exact at inventory binding', async () => {
  const { scope, inventory } = await state()
  assert.equal(inventory.threads[0].runFinishedAt, '2026-11-06T19:56:45.867476+00:00')
  const target = inventory.threads.find(item => item.runId === PINNED_HISTORY[13].runId)
  target.operationId = id(997)
  assert.throws(() => allocationTargets(scope, inventory), /allocation_binding_changed/)
})
