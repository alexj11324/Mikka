import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskWorkspaceState } from './task-workspace-state'

const alpha = { id: '16610000-0000-4000-8000-00000000000a', name: 'Alpha', kind: 'team' }
const beta = { id: '16610000-0000-4000-8000-00000000000b', name: 'Beta', kind: 'personal' }
const read = (workspace = alpha) => ({ workspace, accounts: [{ choices: [alpha, beta] }] })

test('loading, request error and a real mismatch stay distinct', () => {
  assert.deepEqual(taskWorkspaceState({}), { status: 'loading' })
  assert.deepEqual(taskWorkspaceState({ error: new Error('fixture') }), { status: 'error' })
  assert.deepEqual(taskWorkspaceState({ data: read(), target: beta.id }), { status: 'mismatch', current: alpha, target: { id: beta.id, name: 'Beta' } })
  assert.deepEqual(taskWorkspaceState({ data: read(), target: alpha.id }), { status: 'ready', workspace: alpha })
  assert.deepEqual(taskWorkspaceState({ data: read() }), { status: 'ready', workspace: alpha }, 'no target: the current workspace applies')
})

test('a stale read with an error keeps its data; a target outside the account has no name', () => {
  assert.equal(taskWorkspaceState({ data: read(), error: new Error('revalidation') }).status, 'ready')
  const unknown = '16610000-0000-4000-8000-0000000000ff'
  assert.deepEqual(taskWorkspaceState({ data: read(), target: unknown }), { status: 'mismatch', current: alpha, target: { id: unknown, name: null } })
})

test('ids compare through the header contract normalization', () => {
  assert.equal(taskWorkspaceState({ data: read(), target: alpha.id.toUpperCase() }).status, 'ready')
})

test('a read older than the confirmed web selection is not shown as current', () => {
  assert.deepEqual(taskWorkspaceState({ data: read(alpha), confirmed: beta.id }), { status: 'loading' })
  assert.deepEqual(taskWorkspaceState({ data: read(alpha), confirmed: beta.id, error: true }), { status: 'error' })
  assert.equal(taskWorkspaceState({ data: read(beta), confirmed: beta.id.toUpperCase(), target: beta.id }).status, 'ready')
})
