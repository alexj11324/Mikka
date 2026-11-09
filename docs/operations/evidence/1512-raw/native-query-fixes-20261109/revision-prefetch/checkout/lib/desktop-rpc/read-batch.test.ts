import test from 'node:test'
import assert from 'node:assert/strict'
import { ActionFailureError } from '../action-error'
import { WorkspaceError } from '../workspace-error'
import { withRequestLog } from '../request-log'
import { createDesktopRpc, type DesktopActions } from './handler'
import { createReadBatch } from './read-batch'
import { readBatchOwnerRevisions } from './read-batch-context'
import { READ_BATCH_ACTION, READ_BATCH_ACTIONS, type BatchReadAction, type ReadBatchCall } from './read-batch-contract'
import { desktopActionSchemas } from './schemas'
import { currentDesktopSession, withDesktopSession } from './session'
import { decode, encode } from './wire'
import { createRequestScope, requestCache, runRequestScope } from '../../apps/api/src/context'

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const peer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const token = 'synthetic-read-batch-token-'.padEnd(40, 'a')
const otherToken = 'synthetic-read-batch-token-'.padEnd(40, 'b')
const task = { action: 'task-runs.pollTaskRuns', args: [] } satisfies ReadBatchCall
const teams = { action: 'teams.listTeams', args: [] } satisfies ReadBatchCall
const request = (calls: unknown[], authorization = token) => new Request('https://example.test/api/desktop/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authorization}`, 'x-mikka-desktop-protocol': '1' },
  body: JSON.stringify({ version: 1, action: READ_BATCH_ACTION, args: encode([calls]) }),
})

function fixture(overrides: Partial<Record<BatchReadAction, (args: never[]) => Promise<unknown>>> = {}) {
  let invocations = 0
  const lines: string[] = []
  const actions: Record<string, DesktopActions[string]> = Object.fromEntries(READ_BATCH_ACTIONS.map(name => [name, {
    args: desktopActionSchemas[name], invoke: async (args: never[]) => {
      invocations++
      return overrides[name] ? overrides[name](args) : { action: name, at: new Date(0), optional: undefined }
    },
  }]))
  const batch = createReadBatch(() => actions)
  actions[READ_BATCH_ACTION] = { args: desktopActionSchemas[READ_BATCH_ACTION], invoke: async ([calls]) => batch(calls) }
  const handle = withRequestLog('/api/desktop/rpc', createDesktopRpc({
    authenticate: async headers => {
      const bearer = headers.get('authorization')?.slice(7)
      return bearer === token || bearer === otherToken ? { user: { id: bearer === token ? owner : peer }, session: { id: bearer === token ? 'a' : 'b' } } : null
    },
    scope: withDesktopSession, actions,
    error: error => error instanceof ActionFailureError ? { status: error.code === 'authRequired' ? 401 : 400, code: error.code }
      : error instanceof WorkspaceError ? { status: 403, code: 'workspaceAccessDenied' } : { status: 500, code: 'desktop_rpc_failed' },
  }), line => { lines.push(line) })
  return { handle, lines, invocations: () => invocations }
}

test('the ordinary version-1 RPC preserves batch order, original results and wire values', async () => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ 'task-runs.pollTaskRuns': async () => { await wait; return { at: new Date(0), optional: undefined } },
    'teams.listTeams': async () => { release(); return ['team'] } })
  const response = await f.handle(request([task, teams]))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(decode((await response.json()).result), [{ ok: true, result: { at: new Date(0), optional: undefined } }, { ok: true, result: ['team'] }])
  assert.equal(f.invocations(), 2)
  const completed = f.lines.map(line => JSON.parse(line)).filter(line => line.msg === 'rpc_action')
  assert.deepEqual(completed.map(line => line.rpcAction).sort(), ['task-runs.pollTaskRuns', 'teams.listTeams'])
  assert.equal(new Set(completed.map(line => line.httpInvocationId)).size, 1)
})

test('every item is validated before any original action runs, including nested and mutating calls', async () => {
  const f = fixture()
  for (const calls of [
    [], Array.from({ length: 17 }, () => task), [task, { action: READ_BATCH_ACTION, args: [[teams]] }],
    [task, { action: 'account.deleteAccount', args: [{ email: 'synthetic@example.test' }] }],
    [task, { action: 'constructor', args: [] }], [task, { action: 'private.unknown', args: [] }],
    [task, { action: 'teams.listTeams', args: ['forged-workspace'] }],
    [task, { action: 'coordinator.syncCoordinatorChat', args: ['invalid'] }],
    [task, { ...teams, userId: peer }], [task, { action: teams.action, args: {}, workspaceId: peer }],
  ]) {
    const response = await f.handle(request(calls))
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { version: 1, ok: false, error: { code: 'desktop_rpc_request_invalid' } })
  }
  assert.equal(f.invocations(), 0)
  const accepted = await f.handle(request(Array.from({ length: 16 }, () => task)))
  assert.equal(accepted.status, 200)
  assert.equal(f.invocations(), 16, 'batching shares metadata, never drops an original data read')
})

test('each business failure keeps the single-action HTTP mapping without exposing its error message', async () => {
  const canary = 'PRIVATE_BATCH_ERROR_CANARY'
  const f = fixture({
    'task-runs.pollTaskRuns': async () => { throw new Error(canary) },
    'teams.listTeams': async () => { throw new WorkspaceError(canary) },
    'projects.listProjects': async () => { throw new ActionFailureError('validationGeneric') },
  })
  const response = await f.handle(request([task, teams, { action: 'projects.listProjects', args: [] }]))
  assert.equal(response.status, 200)
  const raw = await response.text()
  assert.deepEqual(decode(JSON.parse(raw).result), [
    { ok: false, status: 500, error: { code: 'desktop_rpc_failed' } },
    { ok: false, status: 403, error: { code: 'workspaceAccessDenied' } },
    { ok: false, status: 400, error: { code: 'validationGeneric' } },
  ])
  assert.equal(raw.includes(canary), false)
  assert.equal(f.lines.some(line => line.includes(canary) || line.includes(token)), false)
  assert.deepEqual(f.lines.map(line => JSON.parse(line)).filter(line => line.msg === 'rpc_action').map(line => line.status).sort(), [400, 403, 500])
})

test('thrown and returned authRequired both preserve Main HTTP 401 after all item work settles', async () => {
  for (const returned of [false, true]) {
    let release!: () => void, completed = false, started!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const f = fixture({ 'issues.syncIssueList': async () => {
      if (returned) return { error: 'authRequired' }
      throw new ActionFailureError('authRequired')
    }, 'teams.listTeams': async () => { started(); await wait; return [] } })
    const pending = f.handle(request([{ action: 'issues.syncIssueList', args: [] }, teams])).then(response => { completed = true; return response })
    await entered
    try { await Promise.resolve(); assert.equal(completed, false) } finally { release() }
    const response = await pending
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { version: 1, ok: false, error: { code: 'authRequired' } })
    assert.equal(f.lines.map(line => JSON.parse(line)).filter(line => line.msg === 'rpc_action').length, 2)
  }
})

test('parallel batch requests retain their real session and each original ownership check', async () => {
  const f = fixture({ 'coordinator.syncCoordinatorChat': async ([bot]) => {
    await Promise.resolve()
    const session = currentDesktopSession() as { user: { id: string } }
    if (bot !== session.user.id) throw new WorkspaceError('workspaceAccessDenied')
    return { owner: session.user.id }
  } })
  const [a, b, cross, revoked] = await Promise.all([
    f.handle(request([{ action: 'coordinator.syncCoordinatorChat', args: [owner] }])),
    f.handle(request([{ action: 'coordinator.syncCoordinatorChat', args: [peer] }], otherToken)),
    f.handle(request([{ action: 'coordinator.syncCoordinatorChat', args: [peer] }])),
    f.handle(request([task], 'revoked-token-with-no-real-session'.padEnd(40, 'x'))),
  ])
  assert.deepEqual(decode((await a.json()).result), [{ ok: true, result: { owner } }])
  assert.deepEqual(decode((await b.json()).result), [{ ok: true, result: { owner: peer } }])
  assert.deepEqual(decode((await cross.json()).result), [{ ok: false, status: 403, error: { code: 'workspaceAccessDenied' } }])
  assert.equal(revoked.status, 401)
  assert.equal(f.invocations(), 3)
  assert.equal(currentDesktopSession(), undefined)
})

test('batch readers share the API request memo while later requests authorize a fresh workspace view', async () => {
  let reads = 0, allowed = true
  const context = requestCache(async (ownerId: string, locale: string, selected: string) => {
    reads++; await Promise.resolve()
    if (!allowed) throw new WorkspaceError('workspaceAccessDenied')
    return { ownerId, locale, selected }
  })
  const read = async () => context((currentDesktopSession() as { user: { id: string } }).user.id, 'en', 'selected-workspace')
  const f = fixture({ 'projects.listProjects': read, 'teams.listTeams': read })
  const invoke = () => {
    const input = request([{ action: 'projects.listProjects', args: [] }, teams])
    return runRequestScope(createRequestScope(input), () => f.handle(input))
  }
  assert.equal((await invoke()).status, 200)
  assert.equal(reads, 1, 'the real API requestCache is shared across the two original readers')
  allowed = false
  const response = await invoke()
  assert.deepEqual(decode((await response.json()).result), [
    { ok: false, status: 403, error: { code: 'workspaceAccessDenied' } },
    { ok: false, status: 403, error: { code: 'workspaceAccessDenied' } },
  ])
  assert.equal(reads, 2, 'a later HTTP request cannot retain the prior membership observation')
})

test('only the validated prepared owner readers contribute revision kinds across different readiness times', async () => {
  let release!: () => void
  const started = new Promise<void>(resolve => { release = resolve })
  const queries: string[][][] = []
  const database = { query: async (_sql: string, values: string[][]) => {
    queries.push(values)
    return { rows: values[0].map((kind, index) => ({ kind, id: values[1][index], revision: '7' })) }
  } } as unknown as Parameters<typeof readBatchOwnerRevisions>[0]
  const home = { ownerId: owner, workspaceId: owner }
  const f = fixture({
    'task-runs.pollTaskRuns': async () => {
      const revisions = await readBatchOwnerRevisions(database, [{ kind: 'task_run_list', id: owner }], home)
      release(); return { revisions }
    },
    'issues.syncIssueList': async () => {
      await started
      return { revisions: await readBatchOwnerRevisions(database, [{ kind: 'issue_list', id: owner }], home) }
    },
  })
  const response = await f.handle(request([task, { action: 'issues.syncIssueList', args: [] },
    { action: 'bots.pollBots', args: [] }, { action: 'coordinator.syncCoordinatorChat', args: [owner] }, teams]))
  assert.equal(response.status, 200)
  assert.deepEqual(queries, [[['issue_list', 'task_run_list'], [owner, owner]]], 'unrequested lists and bot entity keys are not guessed')
  const items = decode((await response.json()).result) as { ok: true; result: { revisions: Record<string, number> } }[]
  assert.deepEqual(items.slice(0, 2), [
    { ok: true, result: { revisions: { [`task_run_list:${owner}`]: 7 } } },
    { ok: true, result: { revisions: { [`issue_list:${owner}`]: 7 } } },
  ])
})
