import assert from 'node:assert/strict'
import test from 'node:test'
import { toAuditRow } from '../audit/events'
import { secretAuditEvent } from './audit-map'

const actor = { id: 'u-1', name: 'Mia' }
const workspaceId = '11111111-1111-4111-8111-111111111111'

test('secret and env events map onto the audit catalogue with allowlisted metadata only', () => {
  const created = secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'secret.created', target: { type: 'secret', id: 's1', label: 'VERCEL_TOKEN' }, metadata: { scope: 'workspace', role: 'admin' } }, actor)
  assert.deepEqual(created && toAuditRow(created).metadata, { scope: 'workspace' })
  assert.equal(created && toAuditRow(created).targetLabel, 'VERCEL_TOKEN')
  const env = secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'env.updated', target: { type: 'env', id: 'e1', label: 'NODE_ENV' }, metadata: { role: 'admin', from: ['a'], to: ['b'] } }, actor)
  assert.deepEqual(env && toAuditRow(env).metadata, {})
  const repo = secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'env.created', target: { type: 'env', id: 'e2', label: 'DATABASE_URL' }, metadata: { scope: 'repository', repository: 'acme/app' } }, actor)
  assert.deepEqual(repo && toAuditRow(repo).metadata, { scope: 'repo' })
  const gone = secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'secret.deleted', target: { type: 'secret', id: 's1', label: 'VERCEL_TOKEN' } }, actor)
  assert.equal(gone && toAuditRow(gone).category, 'secret')
})

test('denied and skipped events stay out of the log', () => {
  assert.equal(secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'secret.replace_denied', target: { type: 'secret', id: 'x', label: '' } }, actor), null)
  assert.equal(secretAuditEvent({ workspaceId, actorId: 'u-1', action: 'secret.injection_skipped', target: { type: 'secret', id: 'x', label: 'PATH' } }, actor), null)
})

test('secret delivery changes are auditable without copying secret-bearing configuration', () => {
  const changed = secretAuditEvent({ workspaceId, actorId: actor.id, action: 'secret.replaced', target: { type: 'secret', id: 's1', label: 'API_TOKEN' },
    metadata: { delivery: 'direct', previousDelivery: 'protected', secret: 'synthetic-canary', capability: 'opaque-bearer', origin: 'https://api.example.com?secret=synthetic-canary' } }, actor)
  assert.deepEqual(changed && toAuditRow(changed).metadata, { delivery: 'direct', previousDelivery: 'protected' })
  const invalid = secretAuditEvent({ workspaceId, actorId: actor.id, action: 'secret.created', target: { type: 'secret', id: 's1', label: 'API_TOKEN' },
    metadata: { delivery: 'synthetic-canary', previousDelivery: 'https://evil.example' } }, actor)
  assert.deepEqual(invalid && toAuditRow(invalid).metadata, {})
  assert.ok(!JSON.stringify(changed).includes('synthetic-canary'))
  assert.ok(!JSON.stringify(changed).includes('opaque-bearer'))
})

test('Project and Thread custody keeps exact opaque scope references and rejects private data as metadata', () => {
  const projectId = '22222222-2222-4222-8222-222222222222', threadId = '33333333-3333-4333-8333-333333333333'
  const moved = secretAuditEvent({ workspaceId, actorId: actor.id, action: 'secret.replaced', target: { type: 'secret', id: 's1', label: 's1' },
    metadata: { scope: 'thread', resourceId: threadId, previousScope: 'project', previousResourceId: projectId, name: 'PRIVATE_SECRET_NAME', value: 'synthetic-private-value' } }, actor)
  assert.deepEqual(moved && toAuditRow(moved).metadata, { scope: 'thread', resourceId: threadId, previousScope: 'project', previousResourceId: projectId })
  assert.ok(!JSON.stringify(moved).includes('PRIVATE_SECRET_NAME') && !JSON.stringify(moved).includes('synthetic-private-value'))
  const invalid = secretAuditEvent({ workspaceId, actorId: actor.id, action: 'env.created', target: { type: 'env', id: 's1', label: 's1' },
    metadata: { scope: 'synthetic-private-value', resourceId: 'synthetic-private-value' } }, actor)
  assert.deepEqual(invalid && toAuditRow(invalid).metadata, {})
})
