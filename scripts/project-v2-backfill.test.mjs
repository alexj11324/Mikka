import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveProjectWorkspace } from './project-v2-backfill.mjs'

const alpha = '00000000-0000-4000-8000-000000000001'
const beta = '00000000-0000-4000-8000-000000000002'
const taskId = '00000000-0000-4000-8000-000000000003'
const project = { id: '00000000-0000-4000-8000-000000000004', userId: 'creator', workspaceId: null, issueIds: [], name: 'Personal', team: 'Mikka' }
const tenants = new Set([alpha, beta])
const task = { id: taskId, workspaceId: alpha, ownershipState: 'bound' }

test('empty Project does not inherit creator or display-name tenancy', () => {
  assert.deepEqual(resolveProjectWorkspace(project, [], [], tenants), { workspaceId: null, reason: 'missing_evidence' })
})
test('stable task tenancy binds an ungrouped Project without any Team', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: [taskId] }, [], [task], tenants), { workspaceId: alpha, reason: null })
})
test('verified Team links establish empty Project tenancy and multiple Teams may agree', () => {
  assert.deepEqual(resolveProjectWorkspace(project, [{ workspaceId: alpha, verified: true }, { workspaceId: alpha, verified: true }], [], tenants), { workspaceId: alpha, reason: null })
})
test('conflicting trusted evidence is quarantined', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: [taskId] }, [{ workspaceId: beta, verified: true }], [task], tenants), { workspaceId: null, reason: 'conflicting_evidence' })
})
test('dangling or corrupt Team evidence cannot grant a tenant', () => {
  assert.deepEqual(resolveProjectWorkspace(project, [{ workspaceId: alpha, verified: false }], [], tenants), { workspaceId: null, reason: 'conflicting_evidence' })
})
test('missing/quarantined tasks prevent guessing even when a Team exists', () => {
  for (const tasks of [[], [{ ...task, workspaceId: null, ownershipState: 'pending' }]]) {
    assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: [taskId] }, [{ workspaceId: alpha, verified: true }], tasks, tenants), { workspaceId: null, reason: 'unresolved_tasks' })
  }
})
test('a deleted Workspace is never recreated or substituted', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: [taskId] }, [], [task], new Set()), { workspaceId: null, reason: 'missing_workspace' })
})
test('legacy multi-project task ambiguity quarantines both candidate projects', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: [taskId] }, [], [task], tenants, [taskId]), { workspaceId: null, reason: 'conflicting_task_projects' })
})
test('invalid legacy IDs remain evidence for repair rather than being dropped', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, issueIds: ['not-a-uuid'] }, [], [], tenants), { workspaceId: null, reason: 'invalid_task_ids' })
})
test('an explicit canonical tenant cannot be moved by legacy evidence', () => {
  assert.deepEqual(resolveProjectWorkspace({ ...project, workspaceId: beta, issueIds: [taskId] }, [], [task], tenants), { workspaceId: null, reason: 'conflicting_evidence' })
})
