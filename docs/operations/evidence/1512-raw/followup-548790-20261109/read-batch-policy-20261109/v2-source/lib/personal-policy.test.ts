import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mock, test } from 'node:test'
import type { Pool } from 'pg'
import { COMMIT_EXECUTOR } from './db/commit-effects'
import { createReadBatch } from './desktop-rpc/read-batch'
import { withReadBatchContext } from './desktop-rpc/read-batch-context'
import { desktopActionSchemas } from './desktop-rpc/schemas'

const changed = () => assert.fail('a read cannot emit an execution side effect')
for (const [path, names] of [
  ['./live/panels.ts', ['runChanged']],
  ['./live/lists.ts', ['runListChanged']],
  ['./device-gateway-notify.ts', ['runControlChanged']],
  ['./due-timer.ts', ['armDueTimerAfterCommit']],
] as const) mock.module(new URL(path, import.meta.url).href, {
  namedExports: Object.fromEntries(names.map(name => [name, changed])),
})
const { othersMayUse, pooledOwners, memberSubscriptionsAllowed } = await import('./personal-policy')
const { usableApiKeys } = await import('./model-api-keys')

function reader(results: { allowOthers: boolean }[][], error?: Error) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = { async query(sql: string, values: unknown[]) {
    calls.push({ sql, values })
    assert.match(sql, /^SELECT /)
    assert.deepEqual(values, ['payor', 'workspace'])
    if (error) throw error
    assert.ok(calls.length <= results.length, 'one fresh read per permission check')
    return { rows: results[calls.length - 1] }
  } } as unknown as Pick<Pool, 'query'>
  return { query, calls }
}

test('a shared credential check returns its current authorization in one read', async () => {
  const { query, calls } = reader([[{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(calls.length, 1)
})

for (const [label, rows] of [['missing', []], ['refused', [{ allowOthers: false }]]] as const) {
  test(`a ${label} share does not issue an additional read or write`, async () => {
    const { query, calls } = reader([Array.from(rows)])
    assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
    assert.equal(calls.length, 1)
  })
}

test('repeated permission checks observe revoke and restore without reusing an earlier grant', async () => {
  const { query, calls } = reader([[{ allowOthers: true }], [{ allowOthers: false }], [{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(calls.length, 3)
})

test('a failed authorization read propagates its original cause without another query', async () => {
  const error = new Error('fixture_connection_failed')
  const { query, calls } = reader([], error)
  await assert.rejects(othersMayUse(query, 'payor', 'workspace'), cause => cause === error)
  assert.equal(calls.length, 1)
})

const workspace = '10000000-0000-4000-8000-000000000001'
const owner = 'policy-fixture-owner'

function policyReader(allowed: boolean | undefined = true) {
  const calls: string[] = []
  const state = { allowed, error: null as Error | null, sharedKeys: true, sharedOwners: ['policy-fixture-peer'] }
  const key = (mine: boolean) => ({
    id: mine ? '10000000-0000-4000-8000-000000000002' : '10000000-0000-4000-8000-000000000003',
    ownerId: mine ? owner : 'policy-fixture-peer', provider: 'openai', protocol: 'openai', name: mine ? 'own' : 'shared',
    baseUrl: null, last4: 'test', models: ['fixture-model'], modelsError: null, responsesApi: true,
  })
  const query = { async query(sql: string, values: unknown[]) {
    assert.match(sql, /^SELECT /, 'these public readers cannot write')
    if (sql.includes('FROM workspace_personal_policies')) {
      calls.push('policy'); assert.equal(values.length, 1)
      if (state.error) throw state.error
      return { rows: state.allowed === undefined ? [] : [{ subscriptions: state.allowed }] }
    }
    if (sql.includes('FROM model_api_keys WHERE')) {
      calls.push('own-keys'); assert.deepEqual(values, [owner]); return { rows: [key(true)] }
    }
    if (sql.includes('FROM model_api_key_shares')) {
      calls.push('shared-keys'); assert.deepEqual(values, [workspace, owner]); return { rows: state.sharedKeys ? [key(false)] : [] }
    }
    if (sql.includes('FROM workspace_subscription_shares')) {
      calls.push('shared-owners'); assert.deepEqual(values, [workspace, owner]); return { rows: state.sharedOwners.map(ownerId => ({ ownerId })) }
    }
    assert.fail('unexpected policy consumer query')
  } } as unknown as Pick<Pool, 'query'>
  return { query, calls, state }
}

async function readPolicyConsumers(query: Pick<Pool, 'query'>) {
  // The real chat-choice path reads keys before considering pooled subscriptions.
  const keys = await usableApiKeys(query, owner, workspace)
  const owners = await pooledOwners(query, owner, workspace)
  return { keys: keys.map(key => ({ id: key.id, mine: key.mine })), owners }
}

function batchConsumers(query: Pick<Pool, 'query'>) {
  const batch = createReadBatch(() => ({ 'coordinator.syncCoordinatorChat': {
    args: desktopActionSchemas['coordinator.syncCoordinatorChat'], invoke: () => readPolicyConsumers(query),
  } }))
  return batch([{ action: 'coordinator.syncCoordinatorChat', args: [null] }])
}

test('a Native read batch shares its workspace policy across the real key and subscription readers', async () => {
  const f = policyReader()
  assert.deepEqual(await batchConsumers(f.query), [{ ok: true, result: {
    keys: [{ id: '10000000-0000-4000-8000-000000000002', mine: true }, { id: '10000000-0000-4000-8000-000000000003', mine: false }],
    owners: ['policy-fixture-peer'],
  } }])
  assert.equal(f.calls.filter(call => call === 'policy').length, 1, 'one actual policy SELECT for both consumers in this batch')
  assert.deepEqual(f.calls.filter(call => call !== 'policy'), ['own-keys', 'shared-keys', 'shared-owners'], 'consumer guards and data reads still run')
})

test('a refused batch policy still permits own keys and skips every shared credential read', async () => {
  const f = policyReader(false)
  assert.deepEqual(await batchConsumers(f.query), [{ ok: true, result: {
    keys: [{ id: '10000000-0000-4000-8000-000000000002', mine: true }], owners: [],
  } }])
  assert.deepEqual(f.calls, ['policy', 'own-keys'])
  f.state.allowed = undefined
  const [next] = await batchConsumers(f.query)
  assert.equal(next.ok && (next.result as { owners: string[] }).owners.length, 1, 'the next request observes the original absent-policy default')
  assert.equal(f.calls.filter(call => call === 'policy').length, 2, 'false is an observation, not a missing cache entry')
})

test('concurrent batches never share a policy observation, while sibling reads join only their batch', async () => {
  const f = policyReader()
  const read = () => withReadBatchContext(() => Promise.all([
    memberSubscriptionsAllowed(f.query, workspace), memberSubscriptionsAllowed(f.query, workspace),
  ]))
  assert.deepEqual(await Promise.all([read(), read()]), [[true, true], [true, true]])
  assert.equal(f.calls.length, 2)
  f.state.allowed = false
  assert.deepEqual(await read(), [false, false])
  assert.equal(f.calls.length, 3)
})

test('a batch policy belongs to its actual request database executor and exact workspace', async () => {
  const { pool, createRequestDatabaseScope } = await import('./db/request-scope')
  const first = createRequestDatabaseScope('postgres://first.example.invalid/policy-test')
  const second = createRequestDatabaseScope('postgres://second.example.invalid/policy-test')
  const firstPool = first.run(() => Reflect.get(pool, COMMIT_EXECUTOR)) as Pool
  const secondPool = second.run(() => Reflect.get(pool, COMMIT_EXECUTOR)) as Pool
  assert.notEqual(firstPool, secondPool)
  const anotherWorkspace = '10000000-0000-4000-8000-000000000004'
  const calls: string[] = []
  const firstQuery = mock.method(firstPool, 'query', (async (_sql: string, values: string[]) => {
    calls.push(`first:${values[0]}`); return { rows: [{ subscriptions: values[0] === workspace }] }
  }) as Pool['query'])
  const secondQuery = mock.method(secondPool, 'query', (async (_sql: string, values: string[]) => {
    calls.push(`second:${values[0]}`); return { rows: [{ subscriptions: false }] }
  }) as Pool['query'])
  const alias = { [COMMIT_EXECUTOR]: firstPool, query: firstPool.query.bind(firstPool) }
  try {
    const result = await withReadBatchContext(() => Promise.all([
      first.run(() => memberSubscriptionsAllowed(pool, workspace)),
      second.run(() => memberSubscriptionsAllowed(pool, workspace)),
      first.run(() => memberSubscriptionsAllowed(pool, anotherWorkspace)),
      first.run(() => memberSubscriptionsAllowed(alias, workspace)),
      second.run(() => memberSubscriptionsAllowed(pool, workspace)),
    ]))
    assert.deepEqual(result, [true, false, false, true, false])
    assert.deepEqual(calls.sort(), [`first:${workspace}`, `first:${anotherWorkspace}`, `second:${workspace}`].sort())
    await first.run(() => memberSubscriptionsAllowed(pool, workspace))
    assert.equal(calls.length, 4, 'ordinary access still queries the real database')
  } finally {
    firstQuery.mock.restore(); secondQuery.mock.restore()
    await Promise.all([first.close(), second.close()])
  }
})

test('a failed batch policy preserves its original rejection and cannot poison the next request', async () => {
  const f = policyReader(), failure = new Error('synthetic_policy_unavailable')
  f.state.error = failure
  const results = await withReadBatchContext(() => Promise.allSettled([
    memberSubscriptionsAllowed(f.query, workspace), memberSubscriptionsAllowed(f.query, workspace),
  ]))
  assert.equal(f.calls.length, 1)
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, failure)
  }
  const [failed] = await batchConsumers(f.query)
  assert.deepEqual(failed, { ok: false, status: 500, error: { code: 'desktop_rpc_failed' } })
  assert.equal(f.calls.length, 2, 'an independent batch retries the original read once')
  f.state.error = null
  assert.equal((await batchConsumers(f.query))[0].ok, true)
  assert.equal(f.calls.filter(call => call === 'policy').length, 3)
})

test('bound after-work reads fresh after both fulfilled and rejected batch lifetimes', async () => {
  for (const reject of [false, true]) {
    const f = policyReader(), failure = new Error('synthetic_batch_failure')
    let after!: () => Promise<boolean>
    const work = withReadBatchContext(async () => {
      assert.equal(await memberSubscriptionsAllowed(f.query, workspace), true)
      after = AsyncLocalStorage.bind(() => memberSubscriptionsAllowed(f.query, workspace))
      if (reject) throw failure
    })
    if (reject) await assert.rejects(work, error => error === failure)
    else await work
    f.state.allowed = false
    assert.equal(await after(), false)
    f.state.allowed = true
    assert.equal(await after(), true)
    assert.equal(f.calls.length, 3)
  }
})

test('only the policy is shared: credential shares and own-key reads remain fresh in the batch', async () => {
  const f = policyReader()
  await withReadBatchContext(async () => {
    assert.equal((await readPolicyConsumers(f.query)).keys.length, 2)
    f.state.sharedKeys = false; f.state.sharedOwners = []
    assert.deepEqual(await readPolicyConsumers(f.query), {
      keys: [{ id: '10000000-0000-4000-8000-000000000002', mine: true }], owners: [],
    })
  })
  for (const name of ['own-keys', 'shared-keys', 'shared-owners']) assert.equal(f.calls.filter(call => call === name).length, 2)
  assert.equal(f.calls.filter(call => call === 'policy').length, 1)
})

test('ordinary policy readers observe changes on every call without touching batch metadata', async () => {
  const f = policyReader()
  const ordinary = new Proxy(f.query, { get(target, property, receiver) {
    if (property === COMMIT_EXECUTOR) assert.fail('ordinary reads must not inspect the batch executor key')
    return Reflect.get(target, property, receiver)
  } })
  assert.equal(await memberSubscriptionsAllowed(ordinary, workspace), true)
  f.state.allowed = false
  assert.equal(await memberSubscriptionsAllowed(ordinary, workspace), false)
  f.state.allowed = undefined
  assert.equal(await memberSubscriptionsAllowed(ordinary, workspace), true)
  assert.equal(f.calls.length, 3)
})


test('afterJob cannot reuse a foreground policy while its parent read batch is still active', async () => {
  const { afterJob } = await import('./background')
  const f = policyReader()
  let deferred!: () => unknown
  await withReadBatchContext(async () => {
    assert.equal(await memberSubscriptionsAllowed(f.query, workspace), true)
    afterJob('after:factory-dispatch-recovery', () => memberSubscriptionsAllowed(f.query, workspace), {
      retainContext: true, schedule: task => { deferred = task },
    })
    f.state.allowed = false
    assert.equal(await deferred(), false, 'the real deferred job must query its current policy even before the batch settles')
    f.state.allowed = true
    assert.equal(await deferred(), true, 'separate background calls must not share their own earlier observation')
    assert.equal(await memberSubscriptionsAllowed(f.query, workspace), true, 'foreground siblings keep their own batch observation')
    assert.equal(f.calls.length, 3)
  })
})


test('cron and workflow jobs cannot inherit an active foreground policy observation', async () => {
  const { cronJob } = await import('./background')
  const { runJob } = await import('./tracing/jobs')
  for (const kind of ['cron', 'workflow'] as const) {
    const f = policyReader(false)
    const read = () => memberSubscriptionsAllowed(f.query, workspace)
    const job = kind === 'cron' ? cronJob('policy-fixture', read) : () => runJob('workflow:policy-fixture/read', 'workflow', read)
    await withReadBatchContext(async () => {
      assert.equal(await read(), false)
      f.state.allowed = true
      assert.equal(await job(), true)
      f.state.allowed = false
      assert.equal(await job(), false)
      assert.equal(await read(), false)
      assert.equal(f.calls.length, 3)
    })
  }
})
