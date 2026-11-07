import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { tokenWorkspace } from '../lib/tokens/principal'

let user: { id: string; [tokenWorkspace]?: string } | null = { id: 'owner' }
const reads: unknown[][] = [], filtered: unknown[][] = []
const json = (data: unknown, status = 200) => Response.json(data, { status })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: { mobileUser: async () => user, json, unauthorized: () => json({ error: 'authRequired' }, 401) } })
mock.module(new URL('../lib/mobile-threads.ts', import.meta.url).href, { namedExports: { mobileThreads: async (...args: unknown[]) => { reads.push(args); return { threads: [{ id: 'inside' }, { id: 'outside' }], devices: [], live: { ownerId: 'owner', workspaceId: null } } } } })
mock.module(new URL('../lib/tokens/scope.ts', import.meta.url).href, { namedExports: { runsOutsideToken: async (...args: unknown[]) => { filtered.push(args); return new Set(['outside']) } } })
const { GET } = await import('../app/api/mobile/threads/route')
const request = () => GET(new Request('https://app.test/api/mobile/threads', { headers: { 'x-mikka-presence-scope': 'fixture-proof' } }))

test('the signed-in reader receives optional routing metadata and still applies the token filter', async () => {
  const response = await request()
  assert.equal(response.status, 200)
  assert.deepEqual(reads, [['owner', 60, 'fixture-proof']])
  assert.deepEqual(filtered, [[user, ['inside', 'outside']]])
  assert.deepEqual((await response.json()).threads, [{ id: 'inside' }])
})

test('a PAT cannot carry an ambient home proof and unauthenticated requests do not read', async () => {
  reads.length = 0; filtered.length = 0
  user = { id: 'owner', [tokenWorkspace]: 'authorized-team' }
  assert.equal((await request()).status, 200)
  assert.deepEqual(reads, [['owner', 60, undefined]])
  assert.deepEqual(filtered, [[user, ['inside', 'outside']]])
  user = null; reads.length = 0
  assert.equal((await request()).status, 401)
  assert.deepEqual(reads, [])
})
