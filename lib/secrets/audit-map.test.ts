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
