import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { machineGrant } from './grant.mjs'

test('parking a native writer prunes archives once, after persisting its stop and releasing compute', async () => {
  const ports = {
    'cloudflare:workers': 'export class DurableObject {} export class WorkerEntrypoint {} export class RpcTarget {}',
    '@cloudflare/sandbox': 'export class DirectoryBackup {} export class DirectoryBackupGateway {} export class Files {} export class SandboxFileError {}',
  }
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier in ports ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(ports[specifier]) } : next(specifier, context)
  } })
  let TaskMachine
  try { ({ TaskMachine } = await import('./machine.mjs')) } finally { hooks.deregister() }

  const grant = machineGrant({ ownerId: 'owner', workspaceId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    operationId: randomUUID(), repositoryKey: 'v2/github.com/owner/repo', expiresAt: Date.now() + 60_000 })
  const data = new Map([['nativeWriter', 'writer'], ['run', { grant, admittedAt: Date.now(), state: 'running' }]])
  const checkpoint = { id: randomUUID(), sha256: 'a'.repeat(64), bytes: 3 }
  const events = []
  const container = {
    running: true, async exec() { events.push('quiesce'); return { async output() { return { exitCode: 0 } } } },
    async destroy() { events.push('destroy'); this.running = false },
  }
  const machine = Object.assign(Object.create(TaskMachine.prototype), {
    queue: Promise.resolve(), ctx: { id: 'instance', container, storage: {
      async get(key) { return data.get(key) }, async delete(key) { return data.delete(key) },
      async put(key, value) { for (const [k, v] of typeof key === 'string' ? [[key,value]] : Object.entries(key)) data.set(k, v) },
      async setAlarm() {}, async deleteAlarm() {}, async list() { return new Map() },
    } }, env: {
      TASKS: { idFromName() { return 'instance' } },
      CAPACITY: { getByName() { return { async release() { events.push('release') } } } },
    }, workspace: {
      async checkpoint() { events.push('backup'); return checkpoint },
      async prune() {
        events.push('prune')
        assert.equal(data.get('run').state, 'stopped', 'archive maintenance must not block machine retirement')
      },
    },
  })
  const result = await machine.park(grant)
  assert.deepEqual(result.checkpoint, checkpoint)
  assert.equal(result.state, 'stopped')
  assert.deepEqual(events, ['quiesce', 'backup', 'destroy', 'release', 'prune'])
})

test('an uncommitted first checkpoint is reclaimed without removing a committed checkpoint or other files', async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@cloudflare/sandbox') return {
      shortCircuit: true, url: 'data:text/javascript,export class DirectoryBackup {}',
    }
    return next(specifier, context)
  } })
  let TaskWorkspace
  try { ({ TaskWorkspace } = await import('./workspace.mjs')) } finally { hooks.deregister() }

  const prefix = 'task-workspaces/v1/this-task/'
  const id = randomUUID()
  const orphan = prefix + id + '.tar.zst'
  const otherTask = 'task-workspaces/v1/other-task/' + id + '.tar.zst'
  const note = prefix + 'other-format'
  const objects = new Set([otherTask, note])
  let manifest
  const workspace = Object.assign(Object.create(TaskWorkspace.prototype), {
    prefix,
    storage: {
      get() { return manifest },
      put() { throw Error('manifest write interrupted') },
    },
    backups: { async backup() {
      objects.add(orphan)
      return { id, size: 3, sha256: 'a'.repeat(64) }
    } },
    bucket: {
      async list({ prefix }) {
        return { objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false }
      },
      async delete(keys) { for (const key of keys) objects.delete(key) },
    },
  })
  await assert.rejects(workspace.checkpoint(), /manifest write interrupted/)
  assert.equal(await workspace.restore(), false)
  await workspace.prune()
  assert.deepEqual(objects, new Set([otherTask, note]))

  manifest = { id: randomUUID(), size: 3, sha256: 'b'.repeat(64) }
  const committed = prefix + manifest.id + '.tar.zst'
  objects.add(committed)
  objects.add(orphan)
  await workspace.prune()
  await workspace.prune()
  assert.deepEqual(objects, new Set([otherTask, note, committed]))
})
