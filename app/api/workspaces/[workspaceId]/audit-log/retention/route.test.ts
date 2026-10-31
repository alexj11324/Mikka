import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { z } from 'zod'
const origin = 'https://mikka.example', workspaceId = randomUUID()
let session: { user: { id: string }; session: { id: string } } | null = null, denied = false
const calls: unknown[][] = []
class WorkspaceError extends Error {}
let route: typeof import('./route')
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => session } } } })
  mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError } })
  mock.module('@/lib/audit/retention', { namedExports: {
    auditRetentionInput: z.object({ retentionDays: z.number().int().min(1).max(36500).nullable(), legalHold: z.boolean() }).strict(),
    readAuditRetention: async (...args: unknown[]) => { calls.push(args); if (denied) throw new WorkspaceError(); return { retentionDays: null, legalHold: false } },
    configureAuditRetention: async (...args: unknown[]) => { calls.push(args); if (denied) throw new WorkspaceError(); return args[2] },
  } })
  route = await import('./route')
})
beforeEach(() => { session = { user: { id: 'admin' }, session: { id: 'session' } }; denied = false; calls.length = 0 })
const context = { params: Promise.resolve({ workspaceId }) }
const request = (body: unknown, requestOrigin = origin) => new Request(`${origin}/api/workspaces/${workspaceId}/audit-log/retention`, { method: 'PUT', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
test('policy reads and writes require a current human session and workspace authorization', async () => {
  session = null
  assert.equal((await route.GET(new Request(origin), context)).status, 401)
  assert.equal((await route.PUT(request({ retentionDays: 30, legalHold: false }), context)).status, 401)
  assert.equal(calls.length, 0)
  session = { user: { id: 'member' }, session: { id: 'session' } }; denied = true
  assert.equal((await route.GET(new Request(origin), context)).status, 404)
  assert.equal((await route.PUT(request({ retentionDays: 30, legalHold: false }), context)).status, 404)
  assert.deepEqual(calls[1], ['member', workspaceId, { retentionDays: 30, legalHold: false }])
})
test('mutation requires same origin and explicit valid settings; omitted policy never picks a retention period', async () => {
  assert.equal((await route.PUT(request({ retentionDays: 30, legalHold: false }, 'https://other.example'), context)).status, 403)
  for (const body of [{}, { retentionDays: 0, legalHold: false }, { retentionDays: 30, legalHold: false, secret: 'ignored?' }]) assert.equal((await route.PUT(request(body), context)).status, 400)
  assert.equal(calls.length, 0)
  const response = await route.PUT(request({ retentionDays: null, legalHold: true }), context)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(calls[0], ['admin', workspaceId, { retentionDays: null, legalHold: true }])
})
