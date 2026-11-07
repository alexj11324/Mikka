import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { PoolClient } from 'pg'

const tx = {} as PoolClient
let active: unknown
let found: unknown = { id: 'issue' }
let rejection: Error | undefined
const calls: unknown[][] = []
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: {
  withDatabaseClient: async (client: PoolClient, read: () => Promise<unknown>) => {
    assert.equal(client, tx)
    const previous = active
    active = client
    try { return await read() } finally { active = previous }
  },
} })
mock.module(new URL('../issue-access.ts', import.meta.url).href, { namedExports: {
  issueForUser: async (...args: unknown[]) => {
    assert.equal(active, tx)
    calls.push(args)
    if (rejection) throw rejection
    return found
  },
} })
const { factoryAuthorize } = await import('./authorize')
beforeEach(() => { calls.length = 0; found = { id: 'issue' }; rejection = undefined; active = undefined })

test('Factory authorization asks canonical issue access for metadata without its body', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.deepEqual(calls, [['owner', 'issue', false, undefined, { withoutBody: true }]])
  assert.equal(active, undefined)
})

test('Factory authorization rechecks access on every call and returns only the access result', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  found = null
  assert.equal(await factoryAuthorize('owner', 'issue', tx), false)
  found = { id: 'issue' }
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.equal(calls.length, 3)
  assert.equal(active, undefined)
})

test('Factory authorization propagates the canonical access failure without accepting or retrying', async () => {
  rejection = new Error('fixture_access_failed')
  await assert.rejects(factoryAuthorize('owner', 'issue', tx), error => error === rejection)
  assert.equal(calls.length, 1)
  assert.equal(active, undefined)
})
