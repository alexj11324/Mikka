import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { tokenWorkspace } from '@/lib/tokens/principal'

const tx = {} as PoolClient
let active: unknown
let found: unknown = { id: 'issue' }
let rejection: Error | undefined
let workspaceRejection: Error | undefined
const principal = Symbol('fixture native session proof')
const sessionProof = Object.freeze({ kind: 'session', sessionId: 'native-session' })
const reader = Object.freeze(Object.defineProperties({ id: 'owner' }, {
  [principal]: { value: sessionProof },
  [tokenWorkspace]: { value: 'selected-workspace' },
}))
let workspaceReads = 0
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
mock.module(new URL('./workspace-reader.ts', import.meta.url).href, { namedExports: {
  factoryWorkspaceReader: async (userId: string) => {
    assert.equal(active, tx)
    assert.equal(userId, 'owner')
    workspaceReads++
    if (workspaceRejection) throw workspaceRejection
    return reader
  },
} })
const { factoryAuthorize } = await import('./authorize')
beforeEach(() => { calls.length = 0; found = { id: 'issue' }; rejection = undefined; workspaceRejection = undefined; workspaceReads = 0; active = undefined })

test('Factory authorization asks canonical issue access for metadata without its body', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.deepEqual(calls, [[reader, 'issue', false, undefined, { withoutBody: true }]])
  assert.equal(calls[0][0], reader, 'do not replace or spread away the canonical reader')
  assert.equal(Object.getOwnPropertyDescriptor(calls[0][0], principal)?.value, sessionProof)
  assert.equal(Object.getOwnPropertyDescriptor(calls[0][0], tokenWorkspace)?.value, 'selected-workspace')
  assert.equal(workspaceReads, 1)
  assert.equal(active, undefined)
})

test('Factory authorization rechecks access on every call and returns only the access result', async () => {
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  found = null
  assert.equal(await factoryAuthorize('owner', 'issue', tx), false)
  found = { id: 'issue' }
  assert.equal(await factoryAuthorize('owner', 'issue', tx), true)
  assert.equal(calls.length, 3)
  assert.equal(workspaceReads, 3)
  assert.equal(active, undefined)
})

test('Factory authorization cannot fall back to account access when its selected Workspace is refused', async () => {
  workspaceRejection = new Error('selected_workspace_unavailable')
  await assert.rejects(factoryAuthorize('owner', 'issue', tx), error => error === workspaceRejection)
  assert.equal(workspaceReads, 1)
  assert.deepEqual(calls, [])
  assert.equal(active, undefined)
})

test('Factory authorization propagates the canonical access failure without accepting or retrying', async () => {
  rejection = new Error('fixture_access_failed')
  await assert.rejects(factoryAuthorize('owner', 'issue', tx), error => error === rejection)
  assert.equal(calls.length, 1)
  assert.equal(active, undefined)
})
