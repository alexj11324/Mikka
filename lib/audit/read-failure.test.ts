import assert from 'node:assert/strict'
import test from 'node:test'
import { auditReadFailure } from './read-failure'
import { ReadResponseError } from '@/lib/swr/retry'

test('a refused audit read says why instead of "something went wrong"', () => {
  // /api/settings/audit answers 403 to anyone who is not an admin of the workspace (and 401 when signed out).
  assert.deepEqual(auditReadFailure(new ReadResponseError(403)), { kind: 'adminOnly', code: 'workspaceAccessDenied' })
  assert.deepEqual(auditReadFailure(new ReadResponseError(401)), { kind: 'signedOut', code: 'authRequired' })
  // A broken read keeps a code to quote, never the server's body.
  assert.deepEqual(auditReadFailure(new ReadResponseError(500)), { kind: 'failed', code: 'audit_read_failed (http_500)' })
  assert.deepEqual(auditReadFailure(new TypeError('Failed to fetch')), { kind: 'failed', code: 'audit_read_failed (TypeError)' })
})
