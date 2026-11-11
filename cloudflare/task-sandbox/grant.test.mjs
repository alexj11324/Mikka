import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { liveUntil, machineGrant, sameGrant, workspaceName, verifyCheckpoint } from './grant.mjs'

const now = Date.now()
const scope = { ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
  operationId: randomUUID(), expiresAt: now + 300_000, repositoryKey: 'v2/github.com/owner/repo' }

test('task workspaces and fenced run ownership have independent lifetimes', () => {
  const grant = machineGrant(scope)
  const next = machineGrant({ ...scope, runId: randomUUID(), operationId: randomUUID() })
  assert.equal(workspaceName(next), workspaceName(grant))
  assert.equal(sameGrant(next, grant), false)
  for (const change of [{ ownerId: 'other' }, { workspaceId: randomUUID() }, { taskId: randomUUID() }, { repositoryKey: 'v2/github.com/owner/other' }]) {
    const other = machineGrant({ ...scope, ...change })
    assert.notEqual(workspaceName(other), workspaceName(grant))
    assert.equal(sameGrant(other, grant), false)
  }
  assert.throws(() => machineGrant({ ...scope, repositoryKey: 'https://user:token@example.invalid/repo' }), /Invalid/)
  assert.throws(() => machineGrant({ ...scope, taskId: '../other' }), /Invalid/)
})

test('only a live scoped execution lease can retain compute through its original hard deadline', () => {
  assert.equal(liveUntil(scope, now, now + 60_000), now + 60_000)
  assert.throws(() => liveUntil(scope, now, now - 1), /expired/)
  assert.throws(() => liveUntil({ expiresAt: now - 1 }, now, now + 60_000), /expired/)
})

test('recovery requires the exact original task namespace and immutable R2 checkpoint', () => {
  const pin = { instanceId: 'a'.repeat(64), id: randomUUID(), sha256: 'b'.repeat(64) }
  const grant = machineGrant({ ...scope, requiredCheckpoint: pin })
  verifyCheckpoint(grant.requiredCheckpoint, pin.instanceId, pin)
  verifyCheckpoint(undefined, pin.instanceId, null)
  for (const wrong of [null, {...pin,id:{}}, {...pin,instanceId:'wrong'}, {...pin,sha256:'short'}]) {
    assert.throws(() => machineGrant({...scope, requiredCheckpoint:wrong}), /Invalid task checkpoint/)
  }
  for (const wrong of [null, {...pin,id:randomUUID()}, {...pin,sha256:'c'.repeat(64)}]) {
    assert.throws(() => verifyCheckpoint(pin, pin.instanceId, wrong), /checkpoint unavailable/)
  }
  assert.throws(() => verifyCheckpoint(pin, 'd'.repeat(64), pin), /checkpoint unavailable/)
})
