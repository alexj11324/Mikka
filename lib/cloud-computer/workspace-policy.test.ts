import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { effectiveWebComputerPermission, requireWorkspaceComputerPolicy, resolveWorkspaceComputerPolicy } from './workspace-policy'

test('workspace policy preserves allow, ask and deny under the shared policy lock', async () => {
  let row: Record<string, unknown> | undefined
  const calls: string[] = []
  const client = { async query(sql: string) { calls.push(sql); return { rows: row ? [row] : [] } } } as never
  assert.deepEqual(await resolveWorkspaceComputerPolicy(client, 'workspace'), { permission: 'ask', version: 0 })
  for (const permission of ['allow', 'ask', 'deny'] as const) {
    row = { permission, version: 4 }
    assert.deepEqual(await resolveWorkspaceComputerPolicy(client, 'workspace'), { permission, version: 4 })
    if (permission === 'deny') await assert.rejects(requireWorkspaceComputerPolicy(client, 'workspace'), { status: 403 })
    else assert.equal(await requireWorkspaceComputerPolicy(client, 'workspace'), 4)
  }
  row = { permission: 'allow', version: -1 }
  await assert.rejects(resolveWorkspaceComputerPolicy(client, 'workspace'), { status: 503 })
  row = { permission: 'unknown', version: 1 }
  await assert.rejects(resolveWorkspaceComputerPolicy(client, 'workspace'), { status: 503 })
  assert(calls.filter(sql => sql.includes('pg_advisory_xact_lock')).length >= 1)
})

test('the trusted run may only narrow the current workspace decision', () => {
  const run = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: 'allow' as const } }
  assert.equal(effectiveWebComputerPermission('allow', run), 'allow')
  assert.equal(effectiveWebComputerPermission('ask', run), 'ask')
  assert.equal(effectiveWebComputerPermission('deny', run), 'deny')
  assert.equal(effectiveWebComputerPermission('allow', { ...run, readOnly: true }), 'deny')
  assert.equal(effectiveWebComputerPermission('allow', { ...run, permissions: { ...run.permissions, computer_use: 'ask' } }), 'ask')
  assert.equal(effectiveWebComputerPermission('allow', { ...run, permissions: { ...run.permissions, computer_use: 'deny' } }), 'deny')
  assert.throws(() => effectiveWebComputerPermission('allow', undefined), { status: 503 })
  assert.throws(() => effectiveWebComputerPermission('invalid' as never, run), { status: 503 })
})
