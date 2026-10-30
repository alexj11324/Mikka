// Server action wrappers for settings › workspace: who they act as, which
// workspace, how failures become codes, and the current-workspace cookie.
import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

class WorkspaceError extends Error { constructor(readonly code: string) { super(code) } }
const calls: Array<[string, ...unknown[]]> = []
const audits: unknown[] = []
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
let botActions: typeof import('../app/actions/bots')
const inserted: Record<string, unknown>[] = []
let defaults = { defaultModel: 'codex' as string | null, defaultRepository: 'acme/app' as string | null }

before(async () => {
  mock.module('next/headers', { namedExports: {
    cookies: async () => ({ set: (name: string, value: string) => cookieJar.set(name, value), delete: (name: string) => cookieJar.delete(name), get: (name: string) => cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined }),
    headers: async () => new Headers(),
  } })
  mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError, requireWorkspace: async () => { throw new Error('unexpected') }, loadWorkspaceContext: async () => ({ workspace: { id: actor.workspaceId } }) } })
  mock.module('@/lib/workspace-admin/current', { namedExports: { currentWorkspaceActor: async (workspaceId?: string) => { calls.push(['currentWorkspaceActor', workspaceId]); return workspaceId ? { ...actor, workspaceId } : actor } } })
  mock.module('@/lib/audit/record', { namedExports: { recordAuditSafe: async (event: unknown) => { audits.push(event); return null }, auditRequestContext: () => ({ ip: null, geoCity: null, geoCountry: null, geoRegion: null }) } })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => ({ id: actor.userId, email: actor.email, name: actor.name }) } })
  mock.module('@/lib/workspace-admin/general', { namedExports: {
    updateWorkspaceGeneral: respond('updateWorkspaceGeneral', { id: actor.workspaceId, name: 'New', slug: 'new', icon: null }),
    readWorkspaceGeneral: async (...args: unknown[]) => { calls.push(['readWorkspaceGeneral', ...args]); return { id: args[1], name: 'Old', slug: 'old', icon: null, canEdit: true } },
    workspaceDeletionImpact: respond('workspaceDeletionImpact', { bots: 3, tasks: 128, teams: 3, purchasedPoints: 1200 }),
    deleteWorkspaceData: async (...args: unknown[]) => { calls.push(['deleteWorkspaceData', ...args]); if (failure) throw failure; return { deleted: { bots: 0, threads: 0, tasks: 0, projects: 0, teams: 0, invitations: 0, members: 1 }, nextWorkspaceId: args[2] === 'Last' ? null : '22222222-2222-4222-8222-222222222222' } },
  } })
  mock.module('@/lib/workspace-admin/members', { namedExports: { removeMember: respond('removeMember', { removed: true, transferred: { bots: 2 }, label: 'Mia' }), transferOnSuspend: respond('transferOnSuspend', { bots: 0 }) } })
  mock.module('@/lib/workspace-admin/teams', { namedExports: {
    teamDeletionImpact: respond('teamDeletionImpact', { teamId: 't', name: 'Platform', tasks: 42, projects: 5 }),
    deleteTeamData: respond('deleteTeamData', { deleted: { tasks: 42, projects: 5 } }),
  } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: actor.userId, email: actor.email, name: actor.name } }) } } } })
  mock.module('@/lib/db', { namedExports: { db: { insert: () => ({ values: async (row: Record<string, unknown>) => { inserted.push(row) } }) } } })
  mock.module('@/lib/workspace-admin/bots', { namedExports: {
    workspaceBotDefaults: async (workspaceId: string) => { calls.push(['workspaceBotDefaults', workspaceId]); return defaults },
    botDefaultOptions: respond('botDefaultOptions', { defaultModel: 'codex', defaultRepository: null, models: ['mikka', 'codex', 'claude'], repositories: ['acme/app'] }),
    saveBotDefaults: respond('saveBotDefaults', { defaultModel: 'claude', defaultRepository: null }),
    repositoryAvailable: async (workspaceId: string, repository: string) => { calls.push(['repositoryAvailable', workspaceId, repository]); return repository === 'acme/app' },
    workspaceBots: respond('workspaceBots', [{ id: 'b', name: 'Bot', status: 'running', runningThreads: 2 }]),
    listBotThreadsFor: respond('listBotThreadsFor', { threads: [], nextCursor: null }),
    BotDefaultsConflictError: class extends WorkspaceError {},
  } })
  actions = await import('../app/actions/workspace-settings')
  botActions = await import('../app/actions/bots')
  teamActions = await import('../app/actions/teams')
})

function reset() { calls.length = 0; audits.length = 0; cookieJar.clear(); failure = null }
const relevant = () => calls.filter(([name]) => name !== 'currentWorkspaceActor')

test('updateWorkspace acts on the current workspace as the signed-in user and audits a slug change', async () => {
  reset()
  const result = await actions.updateWorkspace({ name: 'New', slug: 'new' })
  assert.deepEqual(result, { id: actor.workspaceId, name: 'New', slug: 'new', icon: null })
  assert.deepEqual(relevant(), [['readWorkspaceGeneral', actor.userId, actor.workspaceId], ['updateWorkspaceGeneral', actor.userId, actor.workspaceId, { name: 'New', slug: 'new' }]])
  assert.equal(audits.length, 1)
  assert.deepEqual((audits[0] as { action: string; metadata: unknown }).action, 'workspace.slug_changed')
  assert.deepEqual((audits[0] as { metadata: unknown }).metadata, { from: 'old', to: 'new' })
})

test('updateWorkspace targets the workspace the settings page shows; a rename alone is not audited', async () => {
  reset()
  const other = '33333333-3333-4333-8333-333333333333'
  await actions.updateWorkspace({ name: 'New' }, other)
  assert.deepEqual(calls, [['currentWorkspaceActor', other], ['updateWorkspaceGeneral', actor.userId, other, { name: 'New' }]])
  assert.equal(audits.length, 0)
})

test('general and deletion impact reads go through the same actor', async () => {
  reset()
  assert.deepEqual(await actions.getWorkspaceGeneral(), { id: actor.workspaceId, name: 'Old', slug: 'old', icon: null, canEdit: true })
  assert.deepEqual(await actions.getWorkspaceDeletionImpact(actor.workspaceId), { bots: 3, tasks: 128, teams: 3, purchasedPoints: 1200 })
  assert.deepEqual(relevant(), [['readWorkspaceGeneral', actor.userId, actor.workspaceId], ['workspaceDeletionImpact', actor.userId, actor.workspaceId]])
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
  assert.deepEqual(relevant()[0], ['deleteWorkspaceData', actor.userId, actor.workspaceId, 'Acme'])
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
  assert.deepEqual(relevant(), [['removeMember', actor.userId, actor.workspaceId, 'member-9', 'heir-3'], ['removeMember', actor.userId, actor.workspaceId, 'member-9', undefined]])
  failure = new WorkspaceError('workspaceCannotRemoveSelf')
  assert.equal((await actions.removeWorkspaceMember(actor.userId)).error, 'workspaceCannotRemoveSelf')
})

test('getTeamDeletionImpact and deleteTeam', async () => {
  reset()
  assert.deepEqual(await teamActions.getTeamDeletionImpact('t'), { teamId: 't', name: 'Platform', tasks: 42, projects: 5 })
  assert.deepEqual(await teamActions.deleteTeam('t', 'Platform'), { deleted: { tasks: 42, projects: 5 } })
  assert.deepEqual(relevant(), [['teamDeletionImpact', actor.userId, 't'], ['deleteTeamData', actor.userId, 't', 'Platform']])
  failure = new WorkspaceError('teamDeleteNameMismatch')
  assert.equal((await teamActions.deleteTeam('t', 'x')).error, 'teamDeleteNameMismatch')
})

test('createBot uses the workspace defaults only for omitted fields', async () => {
  reset(); inserted.length = 0
  await botActions.createBot({ name: 'Scout', color: 'encre', shape: 'cercle' })
  assert.equal(inserted[0].model, 'codex')
  assert.equal(inserted[0].repository, 'acme/app')
  assert.equal(inserted[0].workspaceId, actor.workspaceId)
  await botActions.createBot({ name: 'Scout 2', color: 'encre', shape: 'cercle', model: 'mikka', repository: null })
  assert.equal(inserted[1].model, 'mikka')
  assert.equal(inserted[1].repository, null)
  assert.equal(calls.filter(call => call[0] === 'workspaceBotDefaults').length, 1, 'explicit values skip the defaults read')
  defaults = { defaultModel: null, defaultRepository: null }
  await botActions.createBot({ name: 'Scout 3', color: 'encre', shape: 'cercle' })
  assert.equal(inserted[2].model, null)
  await assert.rejects(botActions.createBot({ name: 'Bad', color: 'encre', shape: 'cercle', model: 'gpt-x' }), /validationGeneric/)
})

test('createBot refuses a repository the workspace has not installed', async () => {
  reset(); inserted.length = 0
  await botActions.createBot({ name: 'Scout', color: 'encre', shape: 'cercle', repository: 'acme/app' })
  assert.equal(inserted[0].repository, 'acme/app')
  await assert.rejects(botActions.createBot({ name: 'Elsewhere', color: 'encre', shape: 'cercle', repository: 'other/secret' }), /botDefaultRepositoryUnavailable/)
  assert.equal(inserted.length, 1)
  assert.deepEqual(calls.filter(call => call[0] === 'repositoryAvailable').map(call => call[2]), ['acme/app', 'other/secret'])
})

test('bot defaults and workspace bot list actions', async () => {
  reset()
  assert.deepEqual((await botActions.getWorkspaceBotDefaults()).error, undefined)
  assert.deepEqual(await botActions.updateWorkspaceBotDefaults({ defaultModel: 'claude' }), { defaultModel: 'claude', defaultRepository: null })
  assert.deepEqual(await botActions.listWorkspaceBots(), { bots: [{ id: 'b', name: 'Bot', status: 'running', runningThreads: 2 }] })
  assert.deepEqual(relevant(), [['botDefaultOptions', actor.workspaceId], ['saveBotDefaults', actor.userId, actor.workspaceId, { defaultModel: 'claude' }], ['workspaceBots', actor.workspaceId]])
  failure = new WorkspaceError('botDefaultRepositoryUnavailable')
  assert.equal((await botActions.updateWorkspaceBotDefaults({ defaultRepository: 'x/y' })).error, 'botDefaultRepositoryUnavailable')
})
