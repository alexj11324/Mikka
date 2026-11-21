import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { TerminalError, terminalInputSchema, terminalResizeSchema } from '@mikka/protocol/coding-terminal'
import { terminalGrant, terminalKey, terminalResponseError } from './wire'
import { terminalFixture } from './test-fixture'

test('one-use tickets bind the complete review scope, captured boot and exact request bytes', () => {
  const f = terminalFixture(), body = JSON.stringify({ data: 'printf hello\n' })
  const signed = terminalGrant(f.prepared, f.scope, f.lease, 'input', body)
  const [encoded, signature] = signed.split('.')
  assert.equal(signature, createHmac('sha256', f.prepared.key).update(encoded!).digest('base64url'))
  const grant = JSON.parse(Buffer.from(encoded!, 'base64url').toString())
  assert.equal(grant.operation, 'input')
  assert.equal(grant.boot, f.prepared.boot)
  assert.equal(grant.sessionId, f.lease.id)
  assert.equal(grant.sessionExpiresAt, Date.parse(f.lease.expiresAt))
  assert.equal(grant.bodyDigest, createHash('sha256').update(body).digest('hex'))
  for (const field of ['runId', 'taskId', 'workspaceId', 'ownerId', 'deviceId', 'repoId', 'worktreePath', 'machineEpoch', 'bindingId'] as const)
    assert.equal(grant[field], f.scope[field], field)
  assert.equal(grant.credentialId, 'session:browser-session-synthetic')
  assert.ok(grant.expiresAt <= Date.now() + 30_000)
  assert.ok(grant.expiresAt > Date.now())
  assert.notEqual(signed, terminalGrant(f.prepared, f.scope, f.lease, 'input', body))
  assert.equal(Object.hasOwn(grant, 'data'), false)
  assert.equal(Object.hasOwn(grant, 'key'), false)
})

test('changed bindings and expired or malformed lease times cannot mint a capability', () => {
  const f = terminalFixture()
  for (const [scope, lease] of [
    [{ ...f.scope, bindingId: 'b'.repeat(64) }, f.lease],
    [{ ...f.scope, sandboxId: null }, f.lease],
    [f.scope, { ...f.lease, expiresAt: new Date(0).toISOString() }],
    [f.scope, { ...f.lease, expiresAt: 'invalid-time' }],
  ] as const) assert.throws(() => terminalGrant(f.prepared, scope, lease, 'stream'), TerminalError)
})

test('gateway keys are isolated by owner, workspace and sandbox without including the app secret', () => {
  const f = terminalFixture(), secret = 'synthetic-auth-fixture-'.repeat(3)
  const target = { ownerId: f.scope.ownerId, workspaceId: f.scope.workspaceId, sandboxId: f.scope.sandboxId! }
  const key = terminalKey(target, secret)
  assert.equal(key.length, 32)
  assert.deepEqual(key, terminalKey(target, secret))
  for (const field of ['ownerId', 'workspaceId', 'sandboxId'] as const)
    assert.notDeepEqual(key, terminalKey({ ...target, [field]: 'different-synthetic-scope' }, secret))
  assert.throws(() => terminalKey(target, undefined), TerminalError)
})

test('closed schemas bound UTF-8 input and resize rather than silently accepting arbitrary actions', () => {
  assert.equal(terminalInputSchema.safeParse({ data: '\x03' }).success, true)
  assert.equal(terminalInputSchema.safeParse({ data: '界'.repeat(5462) }).success, false)
  assert.equal(terminalInputSchema.safeParse({ data: 'pwd\n', sandboxId: 'other' }).success, false)
  assert.equal(terminalResizeSchema.safeParse({ cols: 111, rows: 37 }).success, true)
  assert.equal(terminalResizeSchema.safeParse({ cols: 0, rows: 37 }).success, false)
  assert.equal(terminalResizeSchema.safeParse({ cols: 111, rows: 10_000 }).success, false)
})

test('untrusted remote diagnostics only expose registered codes and bounded bodies', async () => {
  const known = await terminalResponseError(Response.json({ error: 'terminal_already_controlled', message: 'untrusted diagnostic' }, { status: 423 }))
  assert.equal(known.status, 423)
  assert.equal(known.code, 'terminal_already_controlled')
  for (const body of ['{"error":"arbitrary upstream message"}', 'x'.repeat(2000), 'not-json']) {
    const error = await terminalResponseError(new Response(body, { status: 500 }))
    assert.equal(error.code, 'terminal_unavailable')
    assert.equal(error.detail, 'protocol')
  }
})
