import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownerWorkspaceSettingsTargets } from './lists'

test('owner-specific integration settings publish only the owner’s active workspace scopes', async () => {
  const calls: { sql: string; params?: unknown[] }[] = []
  const database = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      return { rows: [
        { ownerId: 'owner', workspaceId: 'personal' },
        { ownerId: 'owner', workspaceId: 'team' },
      ] }
    },
  }
  const typedDatabase = database as unknown as Parameters<typeof ownerWorkspaceSettingsTargets>[0]
  const targets = await ownerWorkspaceSettingsTargets(typedDatabase, typedDatabase, 'owner')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, ['owner'])
  assert.match(calls[0].sql, /m\."userId"=\$1/)
  assert.deepEqual(targets, [
    { scope: { ownerId: 'owner', workspaceId: 'personal' }, events: [{ kind: 'workspace_settings', id: 'personal' }] },
    { scope: { ownerId: 'owner', workspaceId: 'team' }, events: [{ kind: 'workspace_settings', id: 'team' }] },
  ])
})
