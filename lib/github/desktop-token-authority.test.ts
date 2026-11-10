import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { createRunGitHubTokenExchange } from './run-token-exchange'

// The actual authorizer and exchange; only device authentication and the
// machine lookup are substitutes.
const device = '10000000-0000-4000-8000-000000000001'
const workspace = '10000000-0000-4000-8000-000000000002'
const runId = '10000000-0000-4000-8000-000000000003'
let caller: { userId: string; tokenId: string; scopeDeviceId?: string; scopeWorkspaceId?: string } | null
let machineOwner: string | null
let runAvailable = true
let personalAllowed = true
const queries: unknown[][] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../db/index.ts', { db: {}, pool: { query: async (sql: string, params: unknown[]) => {
  if (sql.includes('mikka_run_personal_resources_allowed')) {
    assert.deepEqual(params, [runId, caller?.userId])
    return { rows: [{ allowed: personalAllowed }] }
  }
  if (sql.includes('FROM agent_runs r')) {
    assert.match(sql, /r\."stopRequestedAt" IS NULL AND r\."leaseExpiresAt">now\(\)/)
    assert.match(sql, /d\."ownerId"=r\."userId" AND d\.enabled/)
    assert.match(sql, /d\.kind='cloud' AND \$4::uuid=d\.id/)
    queries.push(params)
    return { rows: runAvailable && params[0] === runId && params[1] === device && params[2] === machineOwner ? [{ remoteKey: 'v2/github.com/owner/repo' }] : [] }
  }
  assert.match(sql, /cloud_machines/); assert.match(sql, /bot_desktops/)
  queries.push(params)
  // The machine row must belong to the device credential's own person.
  return { rowCount: machineOwner !== null && params[0] === device && params[1] === workspace && params[2] === machineOwner ? 1 : 0 }
} } })
stub('../device-link.ts', { authenticateDevice: async () => caller })

let authorize: typeof import('./desktop-token-authority')['authorizeDesktopGitHubToken']
let authorizeRun: typeof import('./desktop-token-authority')['authorizeDeviceRunGitHubToken']
before(async () => { ({ authorizeDesktopGitHubToken: authorize, authorizeDeviceRunGitHubToken: authorizeRun } = await import('./desktop-token-authority')) })
beforeEach(() => { caller = { userId: 'owner', tokenId: 't', scopeDeviceId: device, scopeWorkspaceId: workspace }; machineOwner = 'owner'; runAvailable = true; personalAllowed = true; queries.length = 0 })
const request = () => new Request(`https://mikka.test/v1/devices/${device}/github-token`, { method: 'POST' })

test('the desktop gets only its owner\'s own GitHub credential', async () => {
  const issued: string[] = []
  const exchange = createRunGitHubTokenExchange({ authorize: value => authorize(value, device), issue: async userId => { issued.push(userId); return { token: `synthetic-token-of-${userId}`, expiresAt: null } } })
  const response = await exchange(request())
  assert.equal(response.status, 200)
  assert.equal((await response.json()).token, 'synthetic-token-of-owner')
  assert.deepEqual(issued, ['owner'])
  assert.deepEqual(queries[0], [device, workspace, 'owner'])
})

test('another device, an unscoped device token, a machine of someone else or no running desktop gets nothing', async () => {
  const refusals: (() => void)[] = [
    () => { caller = null },
    () => { caller = { userId: 'owner', tokenId: 't' } },
    () => { caller = { ...caller!, scopeDeviceId: '10000000-0000-4000-8000-000000000009' } },
    () => { machineOwner = 'someone-else' },
    () => { machineOwner = null },
  ]
  for (const refuse of refusals) {
    caller = { userId: 'owner', tokenId: 't', scopeDeviceId: device, scopeWorkspaceId: workspace }; machineOwner = 'owner'
    refuse()
    assert.equal(await authorize(request(), device), null)
  }
  const issued: string[] = []
  machineOwner = 'someone-else'
  const exchange = createRunGitHubTokenExchange({ authorize: value => authorize(value, device), issue: async userId => { issued.push(userId); return { token: 'synthetic', expiresAt: null } } })
  assert.equal((await exchange(request())).status, 403)
  assert.deepEqual(issued, [])
})

test('natural-expiry refresh identifies the owner from the exact live device run', async () => {
  const result = await authorizeRun(request(), device, runId)
  assert.deepEqual(result, { runId, userId: 'owner', remoteKey: 'v2/github.com/owner/repo' })
  assert.deepEqual(queries, [[runId, device, 'owner', device]])
  runAvailable = false
  assert.equal(await authorizeRun(request(), device, runId), null)
  runAvailable = true
  machineOwner = 'someone-else'
  assert.equal(await authorizeRun(request(), device, runId), null)
})

test('a mismatched device token or invalid run identifier cannot refresh any credential', async () => {
  caller = { userId: 'owner', tokenId: 't', scopeDeviceId: workspace, scopeWorkspaceId: workspace }
  assert.equal(await authorizeRun(request(), device, runId), null)
  caller = { userId: 'owner', tokenId: 't', scopeDeviceId: device, scopeWorkspaceId: workspace }
  assert.equal(await authorizeRun(request(), device, 'invalid'), null)
  caller = null
  assert.equal(await authorizeRun(request(), device, runId), null)
  assert.deepEqual(queries, [])
})

test('an owned Shared cloud task cannot renew a personal GitHub credential', async () => {
  personalAllowed = false
  assert.equal(await authorizeRun(request(), device, runId), null)
  assert.deepEqual(queries, [], 'no GitHub machine or run credential lookup follows denial')
})
