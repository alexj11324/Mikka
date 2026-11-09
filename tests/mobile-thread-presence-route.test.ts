import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { tokenWorkspace } from '../lib/tokens/principal'

let user: { id: string; [tokenWorkspace]?: string } | null = { id: 'owner' }
const reads: unknown[][] = [], scopes: unknown[] = []
const json = (data: unknown, status = 200) => Response.json(data, { status })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: { mobileUser: async () => user, json, unauthorized: () => json({ error: 'authRequired' }, 401) } })
mock.module(new URL('../lib/mobile-threads.ts', import.meta.url).href, { namedExports: { mobileThreads: async (...args: unknown[]) => { reads.push(args); return { threads: [{ id: 'inside' }], devices: [], live: { ownerId: 'owner', workspaceId: null } } } } })
mock.module(new URL('../lib/request-workspace.ts', import.meta.url).href, { namedExports: { effectiveRequestWorkspace: async (reader: typeof user) => { scopes.push(reader); return reader?.[tokenWorkspace] ?? 'selected-workspace' } } })
const { GET } = await import('../app/api/mobile/threads/route')
const request = () => GET(new Request('https://app.test/api/mobile/threads', { headers: { 'x-mikka-presence-scope': 'fixture-proof' } }))

test('the signed-in reader receives optional routing metadata and supplies the effective tenant before reading rows', async () => {
  const response = await request()
  assert.equal(response.status, 200)
  assert.deepEqual(reads, [['owner', 60, 'fixture-proof', 'selected-workspace']])
  assert.deepEqual(scopes, [user])
  assert.deepEqual((await response.json()).threads, [{ id: 'inside' }])
})

test('a PAT cannot carry an ambient home proof and unauthenticated requests do not read', async () => {
  reads.length = 0; scopes.length = 0
  user = { id: 'owner', [tokenWorkspace]: 'authorized-team' }
  assert.equal((await request()).status, 200)
  assert.deepEqual(reads, [['owner', 60, undefined, 'authorized-team']])
  assert.deepEqual(scopes, [user])
  user = null; reads.length = 0
  assert.equal((await request()).status, 401)
  assert.deepEqual(reads, [])
})
