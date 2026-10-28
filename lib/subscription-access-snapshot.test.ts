import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscriptionAccessSnapshot } from './subscription-access-snapshot'

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
    await assert.rejects(subscriptionAccessSnapshot({...config,fetcher}), /^Error: subscription_access_unavailable$/)
  }
})
