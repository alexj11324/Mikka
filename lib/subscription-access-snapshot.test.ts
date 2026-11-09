import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizedAccessName, subscriptionAccessSnapshot } from './subscription-access-snapshot'
import { SubscriptionCallTiming, withSubscriptionTiming, withSubscriptionWorkerTiming } from '../packages/daemon/src/subscription-worker-timing'

const name = 'mikka-byos-00000000-0000-4000-8000-000000000001'
const config = { origin: 'https://vault.example', clientId: 'client', clientSecret: 'private', project: 'access-project', environment: 'dev', path: '/access', name }

test('fetches only the requested versioned access projection with a short-lived identity', async () => {
  const requests: Array<{url: URL; init?: RequestInit}> = []
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({url: new URL(String(input)), init})
    return new Response(JSON.stringify(requests.length === 1 ? {accessToken:'workload-token'} : {secret:{secretKey:name,version:1,secretValue:'projection'}}), {status:200})
  }
  assert.deepEqual(await subscriptionAccessSnapshot({...config,fetcher}), {name,value:'projection'})
  assert.equal(requests[1].url.pathname, `/api/v4/secrets/${name}`)
  assert.equal(requests[1].url.searchParams.get('projectId'), 'access-project')
  assert.equal(requests[1].url.searchParams.get('secretPath'), '/access')
  assert.equal(requests[1].url.searchParams.get('version'), '1')
  assert.equal(new Headers(requests[1].init?.headers).get('authorization'), 'Bearer workload-token')
})

test('rejects mismatched, hidden, or wrong-version projections without exposing the response', async () => {
  for (const secret of [{secretKey:'other',version:1,secretValue:'private'}, {secretKey:name,version:2,secretValue:'private'}, {secretKey:name,version:1,secretValueHidden:true,secretValue:'private'}]) {
    let calls = 0
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(++calls === 1 ? {accessToken:'workload-token'} : {secret}), {status:200})
    // The detail says which check failed; the projection's value never reaches the error.
    await assert.rejects(subscriptionAccessSnapshot({...config,fetcher}), /^CodedError: subscription_access_unavailable \(secret_invalid\)$/)
  }
})

test('says which step failed and keeps the cause by name, never the response body', async () => {
  const cases: Array<[typeof fetch, string]> = [
    [async () => { throw new TypeError('fetch failed') }, 'identity_failed'],
    [(() => { let calls = 0; return async () => ++calls === 1 ? new Response(JSON.stringify({accessToken:'workload-token'}), {status:200}) : new Response('private-body', {status:403}) })(), 'http_refused'],
    [(() => { let calls = 0; return async () => ++calls === 1 ? new Response(JSON.stringify({accessToken:'workload-token'}), {status:200}) : new Response('private-body', {status:200}) })(), 'body_invalid'],
  ]
  for (const [fetcher, detail] of cases) {
    const error = await subscriptionAccessSnapshot({...config,fetcher}).then(() => null, (failure: unknown) => failure as Error & {code?: string; detail?: string})
    assert.equal(error?.code, 'subscription_access_unavailable')
    assert.equal(error?.detail, detail)
    assert.doesNotMatch(String(error), /private/)
    if (detail === 'body_invalid') assert.equal(error?.cause, undefined)
  }
})

test('identity stage observation preserves the original authority and projection sequence without retaining their values', async () => {
  const steps: string[] = []
  const call = new SubscriptionCallTiming(), worker = call.startWorker('executeStream')!
  const finish = worker.beginIdentity()
  await withSubscriptionTiming(call, () => withSubscriptionWorkerTiming(worker, async () => {
    const database = { query: async () => { steps.push('authority'); return { rows: [{ accessSecretName: name, workspaceId: 'fixture-private-space', runOwner: 'fixture-private-member' }] } } }
    const scope = { connectionId: '00000000-0000-4000-8000-000000000001', ownerId: 'fixture-private-owner', workspaceId: 'fixture-private-space', provider: 'codex' as const }
    const authorized = await authorizedAccessName(database as never, scope, { bindingId: 'fixture-private-binding', consumerId: 'fixture-private-consumer' }, 1, async user => { steps.push(user === scope.ownerId ? 'owner-member' : 'consumer-member') })
    const fetcher: typeof fetch = async (_url, init) => {
      steps.push(init?.method === 'POST' ? 'login' : 'projection')
      return Response.json(init?.method === 'POST' ? { accessToken: 'fixture-private-token' } : { secret: { secretKey: name, version: 1, secretValue: 'fixture-private-projection' } })
    }
    assert.deepEqual(await subscriptionAccessSnapshot({ ...config, name: authorized, fetcher }), { name, value: 'fixture-private-projection' })
  }))
  finish(); worker.settle('result')
  assert.deepEqual(steps, ['authority', 'consumer-member', 'owner-member', 'login', 'projection'])
  const row = call.snapshot().workers[0]
  assert.deepEqual([row.parentAccessAuthorityCalls, row.identityLoginCalls, row.parentProjectionReadCalls], [1, 1, 1])
  assert.ok(row.parentAccessAuthorityMs !== null && row.identityLoginMs !== null && row.parentProjectionReadMs !== null)
  assert.doesNotMatch(JSON.stringify(call.snapshot()), /fixture-private|mikka-byos|vault\.example/)

  const denied = new SubscriptionCallTiming(), rejectedWorker = denied.startWorker('executeStream')!
  rejectedWorker.beginIdentity()
  await assert.rejects(withSubscriptionTiming(denied, () => withSubscriptionWorkerTiming(rejectedWorker, () => authorizedAccessName({ query: async () => ({ rows: [] }) } as never,
    { connectionId: 'x', ownerId: 'owner', workspaceId: 'space', provider: 'codex' }, { bindingId: 'binding', consumerId: 'consumer' }, 1))), /subscription_access_unavailable/)
  assert.equal(rejectedWorker.snapshot().parentAccessAuthorityCalls, 1)
  assert.equal(rejectedWorker.snapshot().identityLoginCalls, 0)
  assert.equal(rejectedWorker.snapshot().identityLoginMs, null)
})


test('only an authorized connected row without a projection is an explicit preparation hint', async () => {
  const { AccessProjectionMissing } = await import('./subscription-access-snapshot')
  const scope = { ownerId: 'owner', workspaceId: 'space', connectionId: 'connection', provider: 'codex' as const }
  const use = { bindingId: 'binding', consumerId: 'consumer', runId: 'run' }
  const members: string[] = []
  let queries = 0
  const database = { query: async () => { queries++; return { rows: [{ state: 'connected', accessSecretName: null, workspaceId: 'space', runOwner: 'member' }] } } }
  await assert.rejects(authorizedAccessName(database as never, scope, use, 2, async user => { members.push(user) }, true), AccessProjectionMissing)
  assert.equal(queries, 1)
  assert.deepEqual(members, ['member', 'owner'])
  for (const rows of [[], [{ state: 'refreshing', accessSecretName: null }], [{ state: 'connected', accessSecretName: 42 }]]) {
    const failure = await authorizedAccessName({ query: async () => ({ rows }) } as never, scope, use, 2, undefined, true).then(() => null, error => error)
    assert.ok(failure instanceof Error)
    assert.equal(failure instanceof AccessProjectionMissing, false)
  }
  const denied = await authorizedAccessName(database as never, scope, use, 2, async () => { throw new Error('member_inactive') }, true).then(() => null, error => error)
  assert.equal(denied instanceof AccessProjectionMissing, false)
  assert.equal(denied.detail, 'member_inactive')
  const network = new Error('database unavailable')
  await assert.rejects(authorizedAccessName({ query: async () => { throw network } } as never, scope, use, 2), error => error === network)
})

test('snapshot reuses only a live machine token and still authorizes and reads every projection', async () => {
  let logins = 0, reads = 0, authorities = 0
  const clientId = 'bounded-reuse'
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') { logins++; return Response.json({ accessToken: 'fixture-token', expiresIn: 60 }) }
    reads++
    const requested = new URL(String(input)).pathname.split('/').at(-1)!
    return Response.json({ secret: { secretKey: requested, version: 1, secretValue: `projection-${reads}` } })
  }
  const scope = { ownerId: 'owner', workspaceId: 'space', connectionId: 'connection', provider: 'codex' as const }
  for (let round = 1; round <= 2; round++) {
    const expectedName = round === 1 ? name : name.replace(/1$/, '2')
    const database = { query: async () => { authorities++; return { rows: [{ accessSecretName: expectedName }] } } }
    const authorized = await authorizedAccessName(database as never, scope, { bindingId: 'binding', consumerId: 'consumer' }, 1)
    const call = new SubscriptionCallTiming(), worker = call.startWorker('executeStream')!
    const finishIdentity = worker.beginIdentity()
    await withSubscriptionTiming(call, () => withSubscriptionWorkerTiming(worker, () =>
      subscriptionAccessSnapshot({ ...config, clientId, name: authorized, fetcher })))
    finishIdentity(); worker.settle('result')
    if (round === 2) assert.equal(worker.snapshot().identityLoginMs, null)
    assert.equal(worker.snapshot().identityLoginCalls, round === 1 ? 1 : 0)
    assert.equal(worker.snapshot().parentProjectionReadCalls, 1)
  }
  assert.deepEqual({ logins, reads, authorities }, { logins: 1, reads: 2, authorities: 2 })
  let enteredProjection = false
  await assert.rejects((async () => {
    await authorizedAccessName({ query: async () => ({ rows: [] }) } as never, scope, { bindingId: 'binding', consumerId: 'consumer' }, 1)
    enteredProjection = true
    return subscriptionAccessSnapshot({ ...config, clientId, fetcher })
  })(), /subscription_access_unavailable/)
  assert.equal(enteredProjection, false)
  assert.deepEqual({ logins, reads }, { logins: 1, reads: 2 })
})

test('snapshot refuses an already cancelled call before any login or projection', async () => {
  let calls = 0
  const abort = new AbortController()
  abort.abort(new Error('private-cancellation-reason'))
  const fetcher: typeof fetch = async (_input, init) => {
    calls++
    return Response.json(init?.method === 'POST'
      ? { accessToken: 'fixture-token', expiresIn: 60 }
      : { secret: { secretKey: name, version: 1, secretValue: 'projection' } })
  }
  await assert.rejects(subscriptionAccessSnapshot({ ...config, clientId: 'cancelled-snapshot', signal: abort.signal, fetcher }), /subscription_access_unavailable/)
  assert.equal(calls, 0)
})

test('snapshot evicts refused tokens without retrying the rejected projection', async () => {
  for (const status of [401, 403]) {
    let logins = 0, reads = 0
    let denied = false
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') { logins++; return Response.json({ accessToken: `token-${logins}`, expiresIn: 60 }) }
      reads++
      return denied ? new Response('', { status }) : Response.json({ secret: { secretKey: name, version: 1, secretValue: 'projection' } })
    }
    const options = { ...config, clientId: `denied-${status}`, fetcher }
    await subscriptionAccessSnapshot(options)
    denied = true
    await assert.rejects(subscriptionAccessSnapshot(options), /http_refused/)
    assert.deepEqual({ logins, reads }, { logins: 1, reads: 2 })
    denied = false
    await subscriptionAccessSnapshot(options)
    assert.deepEqual({ logins, reads }, { logins: 2, reads: 3 })
  }
})

test('a cancelled login response never reaches the projection GET or warms the next call', async () => {
  let logins = 0, reads = 0
  const abort = new AbortController()
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      logins++
      if (logins === 1) abort.abort()
      return Response.json({ accessToken: 'fixture-token', expiresIn: 60 })
    }
    reads++
    return Response.json({ secret: { secretKey: name, version: 1, secretValue: 'projection' } })
  }
  const options = { ...config, clientId: 'cancel-after-login', fetcher }
  await assert.rejects(subscriptionAccessSnapshot({ ...options, signal: abort.signal }), /identity_failed/)
  assert.deepEqual({ logins, reads }, { logins: 1, reads: 0 })
  await subscriptionAccessSnapshot(options)
  assert.deepEqual({ logins, reads }, { logins: 2, reads: 1 })
})

test('cancellation after a warm lookup still prevents the projection GET', async () => {
  let logins = 0, reads = 0
  const fetcher: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') { logins++; return Response.json({ accessToken: 'fixture-token', expiresIn: 60 }) }
    reads++
    return Response.json({ secret: { secretKey: name, version: 1, secretValue: 'projection' } })
  }
  const options = { ...config, clientId: 'cancel-after-lookup', fetcher }
  await subscriptionAccessSnapshot(options)
  const abort = new AbortController()
  const pending = subscriptionAccessSnapshot({ ...options, signal: abort.signal })
  abort.abort()
  await assert.rejects(pending, /fetch_failed/)
  assert.deepEqual({ logins, reads }, { logins: 1, reads: 1 })
})
