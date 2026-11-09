import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { PoolClient } from 'pg'

const tx = {} as PoolClient
const principal = Symbol('fixture native session proof')
const workspace = Symbol('fixture selected workspace')
const sessionProof = Object.freeze({ kind: 'session', sessionId: 'native-session' })
const reader = Object.freeze(Object.defineProperties({ id: 'owner' }, {
  [principal]: { value: sessionProof },
  [workspace]: { value: 'selected-workspace' },
}))
let active: unknown
let found: unknown = { id: 'issue' }
let rejection: Error | undefined
let readerRejection: Error | undefined
const calls: unknown[][] = []
const readerCalls: string[] = []
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: {
  withDatabaseClient: async (client: PoolClient, read: () => Promise<unknown>) => {
    assert.equal(client, tx)
    const previous = active
    active = client
    try { return await read() } finally { active = previous }
  },
} })
mock.module(new URL('./workspace-reader.ts', import.meta.url).href, { namedExports: {
  factoryWorkspaceReader: async (userId: string) => {
    assert.equal(active, tx)
    readerCalls.push(userId)
    if (readerRejection) throw readerRejection
    return reader
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
beforeEach(() => {
  calls.length = 0
  readerCalls.length = 0
  found = { id: 'issue' }
  rejection = undefined
  readerRejection = undefined
  active = undefined
})

test('Factory authorization forwards its full canonical reader without the task body', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.deepEqual(readerCalls, ['owner'])
  assert.deepEqual(calls, [[reader, 'issue', false, undefined, { withoutBody: true }]])
  assert.equal(calls[0][0], reader, 'do not replace or spread away the canonical reader')
  assert.equal(Object.getOwnPropertyDescriptor(calls[0][0], principal)?.value, sessionProof)
  assert.equal(Object.getOwnPropertyDescriptor(calls[0][0], workspace)?.value, 'selected-workspace')
  assert.equal(active, undefined)
})

test('Factory authorization rechecks access on every call and returns only the access result', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  found = null
  assert.equal(await factoryAuthorize('owner', 'issue', tx), false)
  found = { id: 'issue' }
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.equal(calls.length, 3)
  assert.deepEqual(readerCalls, ['owner', 'owner', 'owner'])
  assert.equal(active, undefined)
})

test('Factory authorization propagates the canonical access failure without accepting or retrying', async () => {
  rejection = new Error('fixture_access_failed')
  await assert.rejects(factoryAuthorize('owner', 'issue', tx), error => error === rejection)
  assert.equal(calls.length, 1)
  assert.equal(active, undefined)
})

test('a rejected Workspace selection never reaches issue access or retries', async () => {
  readerRejection = new Error('fixture_workspace_denied')
  await assert.rejects(factoryAuthorize('owner', 'issue', tx), error => error === readerRejection)
  assert.deepEqual(readerCalls, ['owner'])
  assert.equal(calls.length, 0)
  assert.equal(active, undefined)
})
