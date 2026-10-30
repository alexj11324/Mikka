import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

const calls: unknown[][] = []
const actor = { userId: 'owned-user', name: 'Owner', workspaceId: 'owned-workspace' }
const audit = async () => {}
let rejected = false
let actions: typeof import('../app/actions/workspace-secrets')

before(async () => {
  mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
  mock.module('@/lib/workspace-admin/current', { namedExports: { currentWorkspaceActor: async () => {
    if (rejected) throw new Error('not authenticated')
    return actor
  } } })
  mock.module('@/lib/workspace-admin/settings-action', { namedExports: { settingsWorkspaceAction: async (work: () => Promise<unknown>) => work() } })
  mock.module('@/lib/audit/events', { namedExports: { auditRequestContext: () => ({ ip: null }) } })
  mock.module('@/lib/secrets/audit', { namedExports: { secretAuditHook: (owner: unknown, context: unknown) => {
    calls.push(['audit', owner, context])
    return audit
  } } })
  mock.module('@/lib/secrets/e2b', { namedExports: {
    getE2BKeyStatus: async () => ({ configured: true }),
    setE2BKey: async (...args: unknown[]) => { calls.push(['set', ...args]); return { configured: true } },
    removeE2BKey: async (...args: unknown[]) => { calls.push(['remove', ...args]); return { removed: true } },
  } })
  const unused = async () => { throw new Error('unrelated secret action') }
  mock.module('@/lib/secrets/store', { namedExports: { createWorkspaceSecret: unused, deleteWorkspaceSecret: unused, listWorkspaceSecrets: unused, replaceWorkspaceSecret: unused } })
  actions = await import('../app/actions/workspace-secrets')
})

test('saving and deleting an E2B key pass the authenticated actor’s transaction audit hook to storage', async () => {
  calls.length = 0
  const input = { apiKey: 'synthetic-e2b-key' }
  await actions.saveE2BKey(input)
  await actions.deleteE2BKey()
  assert.deepEqual(calls, [
    ['audit', { id: actor.userId, name: actor.name }, { ip: null }],
    ['set', actor.userId, actor.workspaceId, input, { audit }],
    ['audit', { id: actor.userId, name: actor.name }, { ip: null }],
    ['remove', actor.userId, actor.workspaceId, audit],
  ])
  calls.length = 0
  rejected = true
  await assert.rejects(actions.saveE2BKey(input), /not authenticated/)
  await assert.rejects(actions.deleteE2BKey(), /not authenticated/)
  assert.deepEqual(calls, [])
  rejected = false
})
