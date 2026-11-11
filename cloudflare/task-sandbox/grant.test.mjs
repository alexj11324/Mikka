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

test('a required recovery cannot silently open another instance, stale R2 data, or a fresh directory', () => {
  const pin = {instanceId:'a'.repeat(64),id:randomUUID(),sha256:'b'.repeat(64)}
  const grant = machineGrant({...scope,requiredCheckpoint:pin})
  assert.deepEqual(grant.requiredCheckpoint,pin)
  verifyCheckpoint(grant.requiredCheckpoint,pin.instanceId,{id:pin.id,sha256:pin.sha256})
  assert.throws(()=>verifyCheckpoint(pin,'c'.repeat(64),pin))
  for (const saved of [null,{...pin,id:randomUUID()},{...pin,sha256:'d'.repeat(64)}]) assert.throws(()=>verifyCheckpoint(pin,pin.instanceId,saved))
  for (const field of ['id','instanceId','sha256']) assert.throws(()=>machineGrant({...scope,requiredCheckpoint:{...pin,[field]:'wrong'}}))
})

test('an async placement failure records the provider image class without exposing provider text', async () => {
  const { startTaskImage, TaskStartError } = await import('./start.mjs')
  const generic = new Error('The container has not been started')
  let starts = 0
  const vm = {
    running: false,
    start() { starts++ },
    monitor: async () => { throw Error('Image not found for private locator') },
    setInactivityTimeout: async () => { throw generic },
  }
  await assert.rejects(startTaskImage(vm, {}, 60_000), error =>
    error instanceof TaskStartError && error.code === 'task_image_unavailable' && error.message === error.code)
  await assert.rejects(startTaskImage({ ...vm, monitor: async () => null }, {}, 60_000), { message: 'task_start_failed' })
  await assert.rejects(startTaskImage({ ...vm, running: true }, {}, 60_000), error => error === generic)
  await startTaskImage({ ...vm, running: true, monitor: () => new Promise(() => {}),
    setInactivityTimeout: async ms => assert.equal(ms, 60_000) }, {}, 60_000)
  assert.equal(starts, 4)
})
