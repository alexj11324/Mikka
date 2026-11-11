import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { liveUntil, machineGrant, sameGrant, workspaceName } from './grant.mjs'

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
