import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { PendingActionView } from '../../../lib/pending-action-view'

let signedIn = true, reads = 0
const identity = { id: 'owner', tokenWorkspaceId: '20000000-0000-4000-8000-000000000001' }
const visible = '10000000-0000-4000-8000-000000000001', hidden = '10000000-0000-4000-8000-000000000002'
const item = (id: string): PendingActionView => ({ id, action: 'send_email', input: { subject: 'Fixture' }, context: null, status: 'pending', createdAt: '2026-11-04T20:00:00.000Z' })
mock.module(new URL('../../../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => signedIn ? { user: identity } : null } } } })
mock.module(new URL('../../../lib/pending-action-store.ts', import.meta.url).href, { namedExports: { listPendingActions: async (userId: string) => { assert.equal(userId, identity.id); reads++; return [item(visible), item(hidden)] } } })
mock.module(new URL('../../../lib/tokens/scope.ts', import.meta.url).href, { namedExports: { pendingActionsOutsideToken: async (user: unknown, ids: string[]) => { assert.equal(user, identity); assert.deepEqual(ids, [visible, hidden]); return new Set([hidden]) } } })
let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
beforeEach(() => { signedIn = true; reads = 0 })

test('unauthenticated list still fails before its database read', async () => {
  signedIn = false
  const response = await GET(new Request('https://mikka.example/api/pending-actions'))
  assert.equal(response.status, 401); assert.equal(reads, 0)
})

test('normal and token callers retain the filtered array contract with private owner/read-time headers', async () => {
  const start = Date.now()
  const response = await GET(new Request('https://mikka.example/api/pending-actions'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [item(visible)])
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-mikka-viewer'), 'owner')
  const observed = Date.parse(response.headers.get('x-mikka-observed-at') ?? '')
  assert.ok(observed >= start && observed <= Date.now())
  assert.equal(reads, 1)
})
