import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { before, mock, test } from 'node:test'
import { verifyStripeSignature } from '../lib/billing/stripe'

class WorkspaceError extends Error {}
class AuditExportError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }
let user: { id: string } | null = { id: 'admin' }
let denied = false
let auditError: AuditExportError | null = null
let webhookError: Error | null = null
let webhookCalls = 0
const workspaceId = '11111111-1111-4111-8111-111111111111'
const secret = 'synthetic-stripe-webhook-secret'
const calls: unknown[][] = []
let auditRoute: typeof import('../app/api/workspaces/[workspaceId]/audit-log/route')
let stripeRoute: typeof import('../app/api/billing/stripe/route')

before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => user ? { user } : null } } } })
  mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError } })
  mock.module('@/lib/audit/export', { namedExports: { AuditExportError, readAuditExportPage: async (...args: unknown[]) => {
    calls.push(args)
    if (auditError) throw auditError
    return { manifest: { id: workspaceId, count: 3 }, events: [{ id: 'second' }], nextOffset: 2 }
  }, createAuditExport: async (...args: unknown[]) => {
    calls.push(args)
    if (auditError) throw auditError
    if (denied) throw new WorkspaceError('workspaceAccessDenied')
    return { manifest: { id: workspaceId, count: 1, digest: '0'.repeat(64) }, events: [{ createdAt: '2026-10-30T00:00:00.000Z', actorName: '=SUM(1,2)', actorType: 'user', action: 'token.created', category: 'security', targetLabel: 'Token', ip: null, geoCity: null }] }
  } } })
  mock.module('@/lib/billing/service', { namedExports: { applyStripeEvent: async () => {
    webhookCalls++
    if (webhookError) throw webhookError
  } } })
  mock.module('@/lib/billing/stripe', { namedExports: { stripeConfig: () => ({ webhookSecret: secret }), verifyStripeSignature } })
  auditRoute = await import('../app/api/workspaces/[workspaceId]/audit-log/route')
  stripeRoute = await import('../app/api/billing/stripe/route')
})

test('audit JSON resumes the same snapshot and preserves explicit export failures', async () => {
  user = { id: 'admin' }; denied = false; auditError = null
  const params = { params: Promise.resolve({ workspaceId }) }
  const response = await auditRoute.GET(new Request(`https://mikka.example/export?format=json&exportId=${workspaceId}&offset=1&limit=1`), params)
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1), ['admin', workspaceId, workspaceId, 1, 1])
  assert.deepEqual(await response.json(), { manifest: { id: workspaceId, count: 3 }, events: [{ id: 'second' }], nextOffset: 2 })
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?format=json&offset=1'), params)).status, 400)
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?format=json&limit=1001'), params)).status, 400)
  auditError = new AuditExportError('auditExportLimitExceeded', 413)
  const failed = await auditRoute.GET(new Request('https://mikka.example/export'), params)
  assert.equal(failed.status, 413)
  assert.deepEqual(await failed.json(), { error: 'auditExportLimitExceeded' })
  auditError = null
})

test('audit CSV requires a session and service authorization, preserves the workspace/filter, and escapes formulas', async () => {
  calls.length = 0
  const request = () => new Request(`https://mikka.example/api/workspaces/${workspaceId}/audit-log?filter=security`)
  const params = { params: Promise.resolve({ workspaceId }) }
  user = null
  assert.equal((await auditRoute.GET(request(), params)).status, 401)
  assert.equal(calls.length, 0)
  user = { id: 'admin' }
  denied = true
  assert.equal((await auditRoute.GET(request(), params)).status, 404)
  denied = false
  const response = await auditRoute.GET(request(), params)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(calls.at(-1), ['admin', workspaceId, 'security'])
  assert.match(await response.text(), /"'=SUM\(1,2\)"/)
  const before = calls.length
  assert.equal((await auditRoute.GET(new Request('https://mikka.example/export?filter=invalid'), params)).status, 400)
  assert.equal((await auditRoute.GET(request(), { params: Promise.resolve({ workspaceId: 'not-a-uuid' }) })).status, 404)
  assert.equal(calls.length, before)
})

test('Stripe webhook verifies raw-body signatures before applying an event and leaves DB failures retryable', async () => {
  webhookCalls = 0
  const body = JSON.stringify({ id: 'evt_synthetic', type: 'test.event', data: { object: {} } })
  const request = (value: string, valid = true) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const digest = createHmac('sha256', secret).update(`${timestamp}.${value}`).digest('hex')
    return new Request('https://mikka.example/api/billing/stripe', { method: 'POST', body: value, headers: { 'stripe-signature': `t=${timestamp},v1=${valid ? digest : '0'.repeat(64)}` } })
  }
  assert.equal((await stripeRoute.POST(request(body, false))).status, 400)
  assert.equal(webhookCalls, 0)
  assert.equal((await stripeRoute.POST(request(body))).status, 200)
  assert.equal(webhookCalls, 1)
  assert.equal((await stripeRoute.POST(request('{invalid'))).status, 400)
  assert.equal(webhookCalls, 1)
  webhookError = new Error('isolated database failure')
  await assert.rejects(stripeRoute.POST(request(body)), /isolated database failure/)
  webhookError = null
})
