import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AuditEventError, auditCategory, auditRequestContext, toAuditRow, type AuditEvent } from './events'

const ws = '7b0f3c9e-2d4a-4e1b-9c3d-5f6a7b8c9d0e'
const base: AuditEvent = { workspaceId: ws, actor: { type: 'user', id: 'u1', name: 'Alex' }, action: 'member.role_changed', target: { type: 'member', id: 'u2', label: 'Mia' } }

test('every action maps to a known category and security is reachable', () => {
  for (const [action, category] of Object.entries(AUDIT_ACTIONS)) {
    assert.ok((AUDIT_CATEGORIES as readonly string[]).includes(category), action)
    assert.match(action, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  }
  assert.equal(auditCategory('token.created'), 'security')
  assert.equal(auditCategory('secret.replaced'), 'secret')
  assert.equal(auditCategory('member.role_changed'), 'permission')
  assert.deepEqual(new Set(Object.values(AUDIT_ACTIONS)), new Set(AUDIT_CATEGORIES))
})

test('toAuditRow snapshots names and derives category from action', () => {
  const row = toAuditRow({ ...base, workspaceId: ws.toUpperCase(), ip: '203.0.113.4', geoCity: 'San Francisco', metadata: { from: 'member', to: 'admin' } })
  assert.deepEqual(row, { workspaceId: ws, actorType: 'user', actorId: 'u1', actorName: 'Alex', action: 'member.role_changed', category: 'permission', targetType: 'member', targetId: 'u2', targetLabel: 'Mia', metadata: { from: 'member', to: 'admin' }, ip: '203.0.113.4', geoCity: 'San Francisco' })
})

test('system actor defaults its name; others need id and name', () => {
  assert.equal(toAuditRow({ ...base, actor: { type: 'system' } }).actorName, 'Mikka')
  assert.equal(toAuditRow({ ...base, actor: { type: 'system' } }).actorId, null)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'user', id: '', name: 'A' } }), AuditEventError)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'user', id: 'u', name: '  ' } }), /actorName/)
  assert.throws(() => toAuditRow({ ...base, actor: { type: 'robot' as 'user', id: 'u', name: 'A' } }), AuditEventError)
})

test('rejects bad workspace, unknown action and bad target', () => {
  assert.throws(() => toAuditRow({ ...base, workspaceId: 'nope' }), /uuid/)
  assert.throws(() => toAuditRow({ ...base, action: 'member.eaten' as 'member.invited' }), /unknown audit action/)
  assert.throws(() => toAuditRow({ ...base, action: 'toString' as 'member.invited' }), /unknown audit action/)
  assert.throws(() => toAuditRow({ ...base, target: { type: ' ' } }), /target type/)
  assert.deepEqual([toAuditRow({ ...base, target: null }).targetType, toAuditRow({ ...base, target: null }).targetLabel], [null, null])
})

test('metadata never carries secret-bearing keys, at any depth', () => {
  for (const key of ['value', 'Token', 'api_key', 'apiKey', 'password', 'client-secret', 'tokenHash'])
    assert.throws(() => toAuditRow({ ...base, metadata: { nested: [{ [key]: 'x' }] } }), /secret-bearing/, key)
  assert.doesNotThrow(() => toAuditRow({ ...base, metadata: { name: 'VERCEL_TOKEN', kind: 'secret', scope: 'repo' } }))
  assert.throws(() => toAuditRow({ ...base, metadata: { blob: 'x'.repeat(5000) } }), /too large/)
  assert.throws(() => toAuditRow({ ...base, metadata: [] as unknown as Record<string, unknown> }), /object/)
})

test('labels are trimmed and clipped; invalid ip dropped', () => {
  const row = toAuditRow({ ...base, actor: { type: 'user', id: 'u1', name: '  Al\n ex ' }, target: { type: 'secret', label: 'x'.repeat(300) }, ip: 'not-an-ip' })
  assert.equal(row.actorName, 'Al ex')
  assert.equal(row.targetLabel?.length, 200)
  assert.equal(row.ip, null)
})

test('auditRequestContext reads first forwarded ip and decoded Vercel city', () => {
  const h = new Headers({ 'x-forwarded-for': '203.0.113.4, 10.0.0.1', 'x-vercel-ip-city': 'San%20Francisco' })
  assert.deepEqual(auditRequestContext(h), { ip: '203.0.113.4', geoCity: 'San Francisco' })
  assert.deepEqual(auditRequestContext(new Headers({ 'x-real-ip': '2001:db8::1' })), { ip: '2001:db8::1', geoCity: null })
  assert.deepEqual(auditRequestContext(new Headers({ 'x-forwarded-for': 'garbage', 'x-vercel-ip-city': '%E0' })), { ip: null, geoCity: '%E0' })
})

test('billing is prepaid credits: no plan or subscription actions, secret.deleted kept', () => {
  for (const action of ['billing.plan_changed', 'billing.subscription_canceled']) {
    assert.equal(action in AUDIT_ACTIONS, false)
    assert.throws(() => toAuditRow({ workspaceId: '00000000-0000-4000-8000-000000000001', actor: { type: 'system' }, action } as unknown as AuditEvent), AuditEventError)
  }
  assert.equal(AUDIT_ACTIONS['billing.credits_purchased'], 'billing')
  assert.equal(AUDIT_ACTIONS['secret.deleted'], 'secret')
})
