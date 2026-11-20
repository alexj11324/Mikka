import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { RequestLogEntry } from '../../../../../lib/request-log'
import { MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'
import { WORKSPACE_REQUEST_HEADER, type WorkspaceReadCommand } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-review'
import { WORKSPACE_GIT_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-git'
import { MCP_CHECK_HEADER, type McpDeviceCheckCommand } from '@mikka/protocol/mcp-check'

// Replace database-backed route operations.
mock.module(new URL('../../../../../lib/db/index.ts', import.meta.url).href, {
  namedExports: { db: {}, pool: {} },
})
mock.module(new URL('../../../../../lib/workspace-db.ts', import.meta.url).href, {
  namedExports: { workspaceDb: {}, workspacePool: {} },
})
const pendingWorkspaceReads = mock.fn(async (_database: unknown, _membership: unknown,
  _caller: { userId: string; tokenId: string }, _deviceId: string, _skip: readonly string[] = [],
  _capabilities: { diff?: boolean; git?: boolean } = {}): Promise<WorkspaceReadCommand[]> => {
  assert.fail('A daemon without the Files capability must never query source requests')
})
mock.module(new URL('../../../../../lib/coding-workspace/requests.ts', import.meta.url).href, { namedExports: { pendingWorkspaceReads } })
const pendingDeviceCommands = mock.fn(async (_id: string, _completed: string[]) => [{ id: 'update-command', kind: 'update' }])
const pendingMcpChecks = mock.fn(async (_userId: string, _deviceId: string): Promise<McpDeviceCheckCommand[]> => [])
mock.module(new URL('../../../../../lib/plugins/runtime.ts', import.meta.url).href, { namedExports: { mcpDeviceChecks: { pending: pendingMcpChecks } } })
mock.module(new URL('../../../../../lib/device-management.ts', import.meta.url).href, { namedExports: { pendingDeviceCommands } })
const authenticateDevice = mock.fn(async () => ({ userId: 'owner', tokenId: 'token' }) as object | null)
const ownsDevice = mock.fn(async () => ({ id: 'device-1', enabled: true }) as object | null)
type Work = { commands: unknown[]; queuedRuns: string[] }
type Check = { work: boolean; deviceCommand: { id: string; kind: 'redetect' | 'restart' | 'update' | 'uninstall' } | null }
const deviceMayHaveWork = mock.fn(async (_deviceId: string, _skip: readonly string[], _options?: { mailboxNotices?: boolean; queued?: boolean; skipDeviceCommands?: readonly string[] }): Promise<Check> => ({ work: true, deviceCommand: null }))
const deviceWork = mock.fn(async (_deviceId: string, _skip: readonly string[], _options?: { mailboxNotices?: boolean; queued?: boolean }): Promise<Work> => ({ commands: [], queuedRuns: [] }))
type Versions = { min: string; latest?: string }
let releases: Versions | undefined
const daemonVersions = mock.fn(async (): Promise<Versions> => releases ?? { min: '0.0.299' })
const logs: RequestLogEntry[] = []
for (const method of ['log', 'warn', 'error'] as const) {
  mock.method(console, method, (line: string) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return
    const entry = JSON.parse(line)
    if (entry.msg === 'api_request') logs.push(entry)
  })
}
mock.module(new URL('../../../../../lib/device-route.ts', import.meta.url).href, {
  namedExports: { withDeviceRoute: (handler: unknown) => handler },
})
mock.module('@/lib/server-runtime/server', { namedExports: { NextResponse: Response } })

let GET: typeof import('./route')['GET']
before(async () => {
  mock.module(new URL('../../../../../lib/daemon-release.ts', import.meta.url).href, {
    namedExports: { daemonVersions },
  })
  mock.module(new URL('../../../../../lib/device-link.ts', import.meta.url).href, {
    namedExports: { authenticateDevice, deviceMayHaveWork, deviceWork, ownsDevice },
  })
  GET = (await import('./route')).GET
})
after(() => mock.restoreAll())
beforeEach(() => {
  authenticateDevice.mock.resetCalls()
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.resetCalls()
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: true }))
  deviceMayHaveWork.mock.resetCalls()
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: true, deviceCommand: null }))
  releases = undefined
  daemonVersions.mock.resetCalls()
  deviceWork.mock.resetCalls()
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: [] }))
  pendingWorkspaceReads.mock.resetCalls()
  pendingMcpChecks.mock.resetCalls()
  pendingMcpChecks.mock.mockImplementation(async () => [])
  pendingWorkspaceReads.mock.mockImplementation(async () => {
    assert.fail('A daemon without the Files capability must never query source requests')
  })
  logs.length = 0
})

function request(signal?: AbortSignal, skip = '', mailboxNotices = false, updates = '') {
  return new Request(`https://preview.example.test/mikka/v1/devices/device-1/commands?x=1${skip ? `&skip=${skip}` : ''}${updates}`, { signal,
    headers: { 'x-mikka-client-version': '0.0.456', ...(mailboxNotices ? { [MAILBOX_NOTICE_HEADER]: '1' } : {}) } })
}
const params = { params: Promise.resolve({ deviceId: 'device-1' }) }

test('work and an empty queue are answered at once and logged separately', async () => {
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  assert.deepEqual(await (await GET(request(), params)).json(), { commands })
  assert.equal(logs[0].outcome, 'work')
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: [] }))
  assert.deepEqual(await (await GET(request(), params)).json(), { commands: [] })
  assert.equal(logs[1].outcome, 'empty')
  assert.ok(logs.every(entry => entry.route === '/v1/devices/[deviceId]/commands'))
  assert.ok(!JSON.stringify(logs).includes('device-1'))
})

test('authentication and ownership failures do not query the queue or label an empty result', async () => {
  authenticateDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 401)
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 404)
  assert.equal(deviceWork.mock.callCount(), 0)
  assert.ok(logs.every(entry => entry.outcome === undefined))
})

test('STDIO check configuration goes only to an authenticated capable owner device and never the request log', async () => {
  const command: McpDeviceCheckCommand = { id: '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    server: { name: 'mcp_fixture', transport: 'stdio', command: 'node', args: [], env: { SERVICE_TOKEN: 'synthetic-mcp-owner-key' } } }
  pendingMcpChecks.mock.mockImplementation(async () => [command])
  assert.deepEqual(await (await GET(request(), params)).json(), { commands: [] })
  assert.equal(pendingMcpChecks.mock.callCount(), 0)
  const capable = () => { const value = request(); value.headers.set(MCP_CHECK_HEADER, '1'); return value }
  authenticateDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(capable(), params)).status, 401)
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(capable(), params)).status, 404)
  assert.equal(pendingMcpChecks.mock.callCount(), 0)
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: false }))
  assert.deepEqual(await (await GET(capable(), params)).json(), { commands: [], mcpChecks: [command] })
  assert.deepEqual(pendingMcpChecks.mock.calls[0].arguments, ['owner', 'device-1'])
  assert.ok(!JSON.stringify(logs).includes('synthetic-mcp-owner-key'))
})

test('a device with scheduling off is never offered queued runs', async () => {
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: false }))
  assert.deepEqual(await (await GET(request(), params)).json(), { commands: [] })
  assert.equal(deviceWork.mock.calls[0].arguments[2]?.queued, false)
})

test('mailbox notice commands require a capable daemon so older clients keep receiving stop and input', async () => {
  await GET(request(), params)
  assert.equal(deviceWork.mock.calls[0].arguments[2]?.mailboxNotices, false)
  await GET(request(undefined, '', true), params)
  assert.equal(deviceWork.mock.calls[1].arguments[2]?.mailboxNotices, true)
})

test('Files requests wake a capable daemon even when its ordinary inbox is empty', async () => {
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  const id = '00000000-0000-4000-8000-000000000001'
  const command: WorkspaceReadCommand = {
    id, identity: { version: 1, runId: id, repoId: id, deviceId: id, workspaceId: id, ownerId: 'owner',
      repositoryKey: 'github.com/owner/repository', bindingId: 'a'.repeat(64) },
    request: { kind: 'tree', path: '', limit: 100 }, expiresAt: new Date(Date.now() + 15_000).toISOString(),
  }
  pendingWorkspaceReads.mock.mockImplementation(async () => [command])
  const ordinary = request()
  const capable = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers), [WORKSPACE_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(capable, params)).json(), { commands: [], workspaceRequests: [command] })
  assert.equal(pendingWorkspaceReads.mock.callCount(), 1)
  assert.deepEqual(pendingWorkspaceReads.mock.calls[0].arguments.slice(2), [{ userId: 'owner', tokenId: 'token' }, 'device-1', [], { diff: false, git: false }])
  assert.equal(deviceWork.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'work')
})

test('an old Files daemon receives Stop while pending Diff stays outside its capability', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const diff: WorkspaceReadCommand = {
    id, identity: { version: 1, runId: id, repoId: id, deviceId: id, workspaceId: id, ownerId: 'owner',
      repositoryKey: 'github.com/owner/repository', bindingId: 'a'.repeat(64) },
    request: { kind: 'diff_snapshot', source: 'working' }, expiresAt: new Date(Date.now() + 15_000).toISOString(),
  }
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  pendingWorkspaceReads.mock.mockImplementation(async (_db, _membership, _caller, _device, _skip, capabilities) => {
    assert.deepEqual(capabilities, { diff: false, git: false })
    return capabilities.diff ? [diff] : []
  })
  const ordinary = request()
  const capable = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers), [WORKSPACE_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(capable, params)).json(), { commands })
  assert.equal(pendingWorkspaceReads.mock.callCount(), 1)
  assert.equal(deviceWork.mock.callCount(), 1)
  assert.equal(logs[0].outcome, 'work')
})

test('Diff capability is passed independently and does not replace Stop delivery', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const diff: WorkspaceReadCommand = {
    id, identity: { version: 1, runId: id, repoId: id, deviceId: id, workspaceId: id, ownerId: 'owner',
      repositoryKey: 'github.com/owner/repository', bindingId: 'a'.repeat(64) },
    request: { kind: 'diff_snapshot', source: 'working' }, expiresAt: new Date(Date.now() + 15_000).toISOString(),
  }
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  pendingWorkspaceReads.mock.mockImplementation(async (_db, _membership, _caller, _device, _skip, capabilities) => {
    assert.deepEqual(capabilities, { diff: true, git: false })
    return [diff]
  })
  const ordinary = request()
  const capable = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers),
    [WORKSPACE_REQUEST_HEADER]: '1', [WORKSPACE_DIFF_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(capable, params)).json(), { commands, workspaceRequests: [diff] })
  assert.equal(pendingWorkspaceReads.mock.callCount(), 1)
})

test('Git capability reaches the request read without enabling Diff', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const git: WorkspaceReadCommand = {
    id, identity: { version: 1, runId: id, repoId: id, deviceId: id, workspaceId: id, ownerId: 'owner',
      repositoryKey: 'github.com/owner/repository', bindingId: 'a'.repeat(64) },
    request: { kind: 'git_status' }, expiresAt: new Date(Date.now() + 15_000).toISOString(),
  }
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  pendingWorkspaceReads.mock.mockImplementation(async (_db, _membership, _caller, _device, _skip, capabilities) => {
    assert.deepEqual(capabilities, { diff: false, git: true })
    return [git]
  })
  const ordinary = request()
  const capable = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers),
    [WORKSPACE_REQUEST_HEADER]: '1', [WORKSPACE_GIT_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(capable, params)).json(), { commands, workspaceRequests: [git] })
  assert.equal(pendingWorkspaceReads.mock.callCount(), 1)
})

test('a Diff header alone cannot enable the Files command transport', async () => {
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  const ordinary = request()
  const unsupported = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers), [WORKSPACE_DIFF_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(unsupported, params)).json(), { commands })
  assert.equal(pendingWorkspaceReads.mock.callCount(), 0)
})

test('unknown Diff header versions do not enable Diff on a Files daemon', async () => {
  pendingWorkspaceReads.mock.mockImplementation(async () => [])
  for (const value of ['0', '2', 'true', '1, 2']) {
    const ordinary = request()
    const unsupported = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers),
      [WORKSPACE_REQUEST_HEADER]: '1', [WORKSPACE_DIFF_REQUEST_HEADER]: value } })
    assert.deepEqual(await (await GET(unsupported, params)).json(), { commands: [] })
    assert.deepEqual(pendingWorkspaceReads.mock.calls.at(-1)?.arguments[5], { diff: false, git: false })
  }
  assert.equal(pendingWorkspaceReads.mock.callCount(), 4)
})

test('Files request skip IDs are UUID-filtered and never disable normal stop delivery', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  pendingWorkspaceReads.mock.mockImplementation(async () => [])
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  const ordinary = request(undefined, '', false, `&skipWorkspaceRequests=invalid,${id}`)
  const capable = new Request(ordinary, { headers: { ...Object.fromEntries(ordinary.headers), [WORKSPACE_REQUEST_HEADER]: '1' } })
  assert.deepEqual(await (await GET(capable, params)).json(), { commands })
  assert.deepEqual(pendingWorkspaceReads.mock.calls[0].arguments[4], [id])
  assert.equal(logs[0].outcome, 'work')
})


test('answers at once and never waits, whatever wait the daemon asks for', async () => {
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  const started = Date.now()
  const response = await GET(new Request('https://preview.example.test/mikka/v1/devices/device-1/commands?wait=25', { headers: { 'x-mikka-client-version': '0.0.456' } }), params)
  assert.deepEqual(await response.json(), { commands: [] })
  assert.ok(Date.now() - started < 1_000)
  assert.equal(deviceMayHaveWork.mock.callCount(), 1, 'one cheap check, no idle loop')
  assert.equal(deviceWork.mock.callCount(), 0, 'nothing pending: the full read is skipped')
  assert.equal(logs[0].outcome, 'empty')
})

test('one read finds both commands and queued runs, outside the runs the daemon already holds', async () => {
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: ['run-new'] }))
  assert.deepEqual(await (await GET(request(undefined, 'run-old'), params)).json(), { commands: [], queuedRuns: ['run-new'] })
  assert.deepEqual(deviceWork.mock.calls[0].arguments, ['device-1', ['run-old'], { mailboxNotices: false, queued: true }])
  assert.equal(logs[0].outcome, 'work')
})

const COMMAND = { id: '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20', kind: 'update' as const }

test('a daemon that sends daemonLatest gets the releases and its oldest pending device command', async () => {
  releases = { min: '0.0.299', latest: '0.0.401' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: COMMAND }))
  const held = '0b9d4f6e-7a1c-4e2b-8f3d-5c6a7b8c9d0e'
  assert.deepEqual(await (await GET(request(undefined, '', false, `&daemonLatest=0.0.400&skipDeviceCommands=${held},not-a-uuid`), params)).json(),
    { commands: [], deviceCommands: [COMMAND], daemonVersions: releases })
  assert.deepEqual(deviceMayHaveWork.mock.calls[0].arguments[2]?.skipDeviceCommands, [held, 'not-a-uuid'], 'commands the daemon holds are left out')
  assert.equal(deviceWork.mock.callCount(), 0, 'no run work: the full read is skipped')
  assert.equal(daemonVersions.mock.callCount(), 1)
  assert.equal(logs[0].outcome, 'work')
})

test('without daemonLatest, no releases or device commands are read', async () => {
  releases = { min: '0.0.299', latest: '0.0.401' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  assert.deepEqual(await (await GET(request(), params)).json(), { commands: [] })
  assert.equal(deviceMayHaveWork.mock.calls[0].arguments[2]?.skipDeviceCommands, undefined)
  assert.equal(daemonVersions.mock.callCount(), 0)
})
