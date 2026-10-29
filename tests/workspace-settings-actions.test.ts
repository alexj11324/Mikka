// Server action wrappers for settings › workspace: who they act as, which
// workspace, how failures become codes, and the current-workspace cookie.
import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

class WorkspaceError extends Error { constructor(readonly code: string) { super(code) } }
const calls: Array<[string, ...unknown[]]> = []
const cookieJar = new Map<string, string>()
let failure: Error | null = null
const actor = { userId: 'admin-1', email: 'a@example.invalid', name: 'A', workspaceId: '11111111-1111-4111-8111-111111111111', role: 'admin' as const }
const respond = <T>(name: string, value: T) => async (...args: unknown[]) => {
  calls.push([name, ...args])
  if (failure) throw failure
  return value
}

let actions: typeof import('../app/actions/workspace-settings')
let teamActions: typeof import('../app/actions/teams')

before(async () => {
  mock.module('next/headers', { namedExports: {
    cookies: async () => ({ set: (name: string, value: string) => cookieJar.set(name, value), delete: (name: string) => cookieJar.delete(name), get: (name: string) => cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined }),
    headers: async () => new Headers(),
  } })
  mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError, requireWorkspace: async () => { throw new Error('unexpected') }, loadWorkspaceContext: async () => { throw new Error('unexpected') } } })
  mock.module('@/lib/workspace-admin/current', { namedExports: { currentWorkspaceActor: async () => actor } })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => ({ id: actor.userId, email: actor.email, name: actor.name }) } })
  mock.module('@/lib/workspace-admin/general', { namedExports: {
    updateWorkspaceGeneral: respond('updateWorkspaceGeneral', { id: actor.workspaceId, name: 'New', slug: 'new', icon: null }),
    deleteWorkspaceData: async (...args: unknown[]) => { calls.push(['deleteWorkspaceData', ...args]); if (failure) throw failure; return { deleted: { bots: 0, threads: 0, tasks: 0, projects: 0, teams: 0, invitations: 0, members: 1 }, nextWorkspaceId: args[2] === 'Last' ? null : '22222222-2222-4222-8222-222222222222' } },
  } })
  mock.module('@/lib/workspace-admin/members', { namedExports: { removeMember: respond('removeMember', { removed: true, transferred: { bots: 2 } }), transferOnSuspend: respond('transferOnSuspend', { bots: 0 }) } })
  mock.module('@/lib/workspace-admin/teams', { namedExports: {
    teamDeletionImpact: respond('teamDeletionImpact', { teamId: 't', name: 'Platform', tasks: 42, projects: 5 }),
    deleteTeamData: respond('deleteTeamData', { deleted: { tasks: 42, projects: 5 } }),
  } })
  actions = await import('../app/actions/workspace-settings')
  teamActions = await import('../app/actions/teams')
})

function reset() { calls.length = 0; cookieJar.clear(); failure = null }

test('updateWorkspace acts on the current workspace as the signed-in user', async () => {
  reset()
  const result = await actions.updateWorkspace({ name: 'New', slug: 'new' })
  assert.deepEqual(result, { id: actor.workspaceId, name: 'New', slug: 'new', icon: null })
  assert.deepEqual(calls, [['updateWorkspaceGeneral', actor.userId, actor.workspaceId, { name: 'New', slug: 'new' }]])
})

test('workspace errors become returned codes; unknown codes become generic', async () => {
  reset()
  failure = new WorkspaceError('workspaceSlugTaken')
  assert.deepEqual(await actions.updateWorkspace({ slug: 'taken' }), { error: 'workspaceSlugTaken', params: undefined })
  failure = new WorkspaceError('some translated sentence')
  assert.deepEqual(await actions.updateWorkspace({ slug: 'taken' }), { error: 'generic', params: undefined })
  failure = new Error('database down')
  await assert.rejects(actions.updateWorkspace({ slug: 'x' }), /database down/, 'programming errors keep propagating')
})

test('deleteWorkspace moves the caller to their next workspace, or clears the cookie', async () => {
  reset()
  cookieJar.set('mikka-workspace', actor.workspaceId)
  const result = await actions.deleteWorkspace(actor.workspaceId, 'Acme')
  assert.equal(result.error, undefined)
  assert.deepEqual(calls[0], ['deleteWorkspaceData', actor.userId, actor.workspaceId, 'Acme'])
  assert.equal(cookieJar.get('mikka-workspace'), '22222222-2222-4222-8222-222222222222')
  await actions.deleteWorkspace(actor.workspaceId, 'Last')
  assert.equal(cookieJar.has('mikka-workspace'), false)
  failure = new WorkspaceError('workspaceDeleteNameMismatch')
  cookieJar.set('mikka-workspace', actor.workspaceId)
  assert.deepEqual(await actions.deleteWorkspace(actor.workspaceId, 'x'), { error: 'workspaceDeleteNameMismatch', params: undefined })
  assert.equal(cookieJar.get('mikka-workspace'), actor.workspaceId, 'a refused delete keeps the cookie')
})

test('removeWorkspaceMember passes the optional new owner', async () => {
  reset()
  assert.deepEqual(await actions.removeWorkspaceMember('member-9', { transferTo: 'heir-3' }), { removed: true, transferred: { bots: 2 } })
  await actions.removeWorkspaceMember('member-9')
  assert.deepEqual(calls, [['removeMember', actor.userId, actor.workspaceId, 'member-9', 'heir-3'], ['removeMember', actor.userId, actor.workspaceId, 'member-9', undefined]])
  failure = new WorkspaceError('workspaceCannotRemoveSelf')
  assert.equal((await actions.removeWorkspaceMember(actor.userId)).error, 'workspaceCannotRemoveSelf')
})

test('getTeamDeletionImpact and deleteTeam', async () => {
  reset()
  assert.deepEqual(await teamActions.getTeamDeletionImpact('t'), { teamId: 't', name: 'Platform', tasks: 42, projects: 5 })
  assert.deepEqual(await teamActions.deleteTeam('t', 'Platform'), { deleted: { tasks: 42, projects: 5 } })
  assert.deepEqual(calls, [['teamDeletionImpact', actor.userId, 't'], ['deleteTeamData', actor.userId, 't', 'Platform']])
  failure = new WorkspaceError('teamDeleteNameMismatch')
  assert.equal((await teamActions.deleteTeam('t', 'x')).error, 'teamDeleteNameMismatch')
})
