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
