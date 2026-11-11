import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { Files } from '@cloudflare/sandbox'
import { machineGrant, sameGrant, workspaceName, verifyCheckpoint, liveUntil, MAX_RUN_MS, CHECKPOINT_TIME_MS } from './grant.mjs'
import { TaskFiles } from './files.mjs'
import { processOptions, taskProcess, stopTaskProcesses } from './process.mjs'
import { TaskWorkspace } from './workspace.mjs'

export { DirectoryBackupGateway } from '@cloudflare/sandbox'

// The Node API holds this service binding. HTTP is closed, including the
// workers.dev hostname. Every operation travels with the frozen Mikka run.
export default class TaskMachines extends WorkerEntrypoint {
  fetch() { return new Response(null, { status: 404 }) }
  #endpoint(identity) {
    const grant = machineGrant(identity)
    return this.env.TASKS.getByName(workspaceName(grant))
  }
  open(identity) { return this.#endpoint(identity).open(identity) }
  park(identity) { return this.#endpoint(identity).park(identity) }
  status(identity) { return this.#endpoint(identity).status(identity) }
  spawn(identity, options) { return this.#endpoint(identity).spawn(identity, options) }
  removePath(identity, path, options) { return this.#endpoint(identity).removePath(identity, path, options) }
  readFile(identity, path) { return this.#endpoint(identity).readFile(identity, path) }
  writeFile(identity, path, bytes) { return this.#endpoint(identity).writeFile(identity, path, bytes) }
}

// Release the slot only after the dedicated compute has confirmed stop.
export class TaskCapacity extends DurableObject {
  acquire(task) {
    return this.ctx.storage.transaction(async tx => {
      const slots = await tx.list({ prefix: 'running:' })
      if (slots.has('running:' + task)) return true
      if (slots.size >= 2) return false
      await tx.put('running:' + task, true)
      return true
    })
  }
  release(task) { return this.ctx.storage.delete('running:' + task) }
}

export class TaskMachine extends DurableObject {
  queue = Promise.resolve()
  constructor(ctx, env) {
    super(ctx, env)
    this.workspace = new TaskWorkspace(ctx, env.WORKSPACES)
    ctx.blockConcurrencyWhile(async () => {
      const run = await ctx.storage.get('run')
      if (!run || run.stoppedAt) return
      if (await ctx.storage.get('nativeWriter')) {
        // DO restart lost the live streams. Stop every writer from the same
        // task, preserve its actual working tree and retire its lease.
        await this.stop(run, 'interrupted', true)
        return
      }
      if (ctx.container?.running) await ctx.container.setInactivityTimeout(this.idleLimit(run))
      await ctx.storage.setAlarm(Math.max(Date.now() + 1, run.settledAt ? Date.now() : run.expiresAt))
    })
  }
  exclusive(operation) {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }
  idleLimit(run) { return Math.max(1, run.hardDeadline + CHECKPOINT_TIME_MS - Date.now()) }
  admission() { return this.env.CAPACITY.getByName('product-task-machines') }
  async startImage(run) {
    const container = this.ctx.container
    if (!container) throw new Error('Task container unavailable')
    container.start({ image: container.images.task, instance: 'standard-1', enableInternet: this.env.NATIVE_TASK_EGRESS === 'direct',
      entrypoint: ['sleep', String(Math.max(1, Math.ceil(this.idleLimit(run) / 1000)))] })
    await container.setInactivityTimeout(this.idleLimit(run))
  }
  async verifyScope(grant) {
    if (this.ctx.id.toString() !== this.env.TASKS.idFromName(workspaceName(grant)).toString()) {
      throw new Error('Task machine scope mismatch')
    }
  }
  open(identity) {
    const grant = machineGrant(identity)
    return this.exclusive(async () => {
      await this.verifyScope(grant)
      const store = this.ctx.storage, now = Date.now()
      const prior = await store.get('run')
      if (prior && sameGrant(prior.grant, grant)) {
        verifyCheckpoint(grant.requiredCheckpoint, this.ctx.id.toString(), prior.grant.requiredCheckpoint)
        verifyCheckpoint(prior.grant.requiredCheckpoint, this.ctx.id.toString(), grant.requiredCheckpoint)
        if (prior.settledAt || prior.stoppedAt) throw new Error('Task machine run already settled')
        if (!this.ctx.container?.running || prior.state !== 'running') throw new Error('Task machine interrupted')
        // An expired lease cannot be revived even if its alarm is delayed.
        liveUntil(prior, now, prior.hardDeadline)
        const expiresAt = liveUntil(grant, now, prior.hardDeadline)
        if (expiresAt > prior.expiresAt) {
          await store.put('run', { ...prior, expiresAt })
          await store.setAlarm(expiresAt)
        }
        return { state: 'running', restored: prior.restored, instanceId: this.ctx.id.toString() }
      }
      if (prior && !prior.stoppedAt) throw new Error('Task machine already has a writer')
      // Old deployments fenced the entire run. Keep every existing tombstone.
      // New runs can resume on a distinct API-authorized operation, retaining
      // the compute already consumed across all prior operations of this run.
      if (await store.get('closed:' + grant.runId) || await store.get('closed-operation:' + grant.operationId)) {
        throw new Error('Task machine run already settled')
      }
      verifyCheckpoint(grant.requiredCheckpoint, this.ctx.id.toString(), await store.get('checkpoint'))
      const consumed = await store.get('spent:' + grant.runId) ?? 0
      const hardDeadline = now + Math.max(0, MAX_RUN_MS - consumed)
      const expiresAt = liveUntil(grant, now, hardDeadline)
      const run = { state: 'starting', grant, hardDeadline, expiresAt, admittedAt: now, consumed }
      await store.setAlarm(expiresAt)
      await store.put('run', run)
      if (!await this.admission().acquire(this.ctx.id.toString())) {
        if (prior) await store.put('run', prior)
        else await store.delete('run')
        await store.deleteAlarm()
        throw new Error('Product task machine capacity exhausted')
      }
      try {
        await this.startImage(run)
        const restored = await this.workspace.restore()
        if (grant.requiredCheckpoint && !restored) throw new Error('Retained task checkpoint unavailable')
        if (restored && this.env.NATIVE_TASK_EGRESS === 'direct') await this.transferNativeHistory('restore')
        if (!restored) await new Files(this.ctx.container).mkdir('/workspace', { recursive: true })
        await store.put('run', { ...run, restored, state: 'running' })
        return { state: 'running', restored, instanceId: this.ctx.id.toString() }
      } catch (error) {
        // No task operation has been authorized. Preserve the prior manifest
        // if cold restoration failed, and never admit an empty substitute.
        await this.stop(run, 'start_failed', false)
        throw error
      }
    })
  }
  async current(grant) {
    await this.verifyScope(grant)
    const run = await this.ctx.storage.get('run')
    if (!run || !sameGrant(run.grant, grant)) throw new Error('Task machine run mismatch')
    return run
  }
  status(identity) {
    const grant = machineGrant(identity)
    return this.exclusive(async () => {
      await this.verifyScope(grant)
      const run = await this.ctx.storage.get('run')
      if (!run || !sameGrant(run.grant, grant)) return { state: 'absent' }
      if (!run.stoppedAt && run.state === 'running' && !this.ctx.container?.running) {
        return this.stop(run, 'interrupted', true)
      }
      return this.receipt(run)
    })
  }
  withMachine(identity, operation) {
    const grant = machineGrant(identity)
    return this.exclusive(async () => {
      const run = await this.current(grant)
      liveUntil(grant, Date.now(), Math.min(run.expiresAt, run.hardDeadline))
      if (run.state !== 'running' || !this.ctx.container?.running) throw new Error('Task machine is not running')
      if (await this.ctx.storage.get('nativeWriter')) throw new Error('Task workspace has an active native writer')
      return operation(this.ctx.container, run)
    })
  }
  spawn(identity, options) {
    const checked = processOptions(options)
    return this.withMachine(identity, async (container, run) => {
      const nonce = crypto.randomUUID()
      // Persist the writer before external I/O. Restarting the object fences
      // this operation even if the provider started it before returning a handle.
      await this.ctx.storage.put('nativeWriter', nonce)
      try {
        return await taskProcess(container, checked, () => this.exclusive(async () => {
          if (await this.ctx.storage.get('nativeWriter') !== nonce) return
          await this.saveNativeWorkspace(container)
          await this.ctx.storage.delete('nativeWriter')
        }))
      } catch (error) {
        await this.stop(run, 'interrupted', true)
        throw error
      }
    })
  }
  async transferNativeHistory(operation) {
    const process = await this.ctx.container.exec(['/usr/bin/setpriv', '--reuid=1000','--regid=1000','--clear-groups',
      '--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','--no-new-privs',
      '/usr/bin/python3','-I','/opt/mikka/task-sandbox/native-history.py',operation], {user:'0:0'})
    if ((await process.output()).exitCode !== 0) throw Error('Native conversation checkpoint unavailable')
  }
  async saveNativeWorkspace(container) {
    await stopTaskProcesses(container)
    if (this.env.NATIVE_TASK_EGRESS === 'direct') await this.transferNativeHistory('save')
    const checkpoint = await this.workspace.checkpoint()
    await this.workspace.prune()
    return checkpoint
  }
  withFiles(identity, operation) { return this.withMachine(identity, c => operation(new TaskFiles(c))) }
  readFile(identity, path) { return this.withFiles(identity, files => files.read(path)) }
  removePath(identity, path, options) {
    return this.withFiles(identity, async files => {
      await files.remove(path, options)
      const checkpoint = await this.workspace.checkpoint()
      await this.workspace.prune()
      return checkpoint
    })
  }
  writeFile(identity, path, bytes) {
    return this.withFiles(identity, async files => {
      await files.write(path, bytes)
      // Do not acknowledge a durable file edit until R2 returned its digest.
      const checkpoint = await this.workspace.checkpoint()
      await this.workspace.prune()
      return checkpoint
    })
  }
  park(identity) {
    const grant = machineGrant(identity)
    return this.exclusive(async () => this.stop(await this.current(grant), 'settled', true))
  }
  receipt(run) {
    return { state: run.state, outcome: run.outcome, admittedAt: run.admittedAt, settledAt: run.settledAt,
      stoppedAt: run.stoppedAt, checkpoint: run.checkpoint, instanceId: this.ctx.id.toString() }
  }
  async stop(run, outcome, save) {
    if (run.stoppedAt) return this.receipt(run)
    const store = this.ctx.storage, container = this.ctx.container
    if (!run.settledAt) {
      run = { ...run, settledAt: Date.now(), outcome, state: 'stopping' }
      await store.put('run', run)
    }
    await store.setAlarm(Date.now() + 15_000)
    if (save && !run.checkpoint && container?.running) {
      const checkpoint = await store.get('nativeWriter') ? await this.saveNativeWorkspace(container) : await this.workspace.checkpoint()
      run = { ...run, checkpoint }
      await store.put('run', run)
    }
    if (save && !run.checkpoint && !container?.running) {
      const saved = await store.get('checkpoint')
      run = { ...run, outcome: 'interrupted', checkpoint: saved ? { id: saved.id, bytes: saved.size, sha256: saved.sha256 } : null }
    }
    if (container?.running) await container.destroy()
    if (container?.running) throw new Error('Task machine stop unconfirmed')
    await store.delete('nativeWriter')
    await this.admission().release(this.ctx.id.toString())
    const stopped = { ...run, state: 'stopped', stoppedAt: Date.now() }
    // Commit the budget and fence atomically. A retried stop cannot double-count.
    await store.put({ run: stopped, ['closed-operation:' + run.grant.operationId]: true,
      ['spent:' + run.grant.runId]: (run.consumed ?? 0) + Math.max(0, stopped.stoppedAt - run.admittedAt) })
    await this.workspace.prune()
    await store.deleteAlarm()
    return this.receipt(stopped)
  }
  alarm() {
    return this.exclusive(async () => {
      const run = await this.ctx.storage.get('run')
      if (!run || run.stoppedAt) { await this.workspace.prune(); return }
      if (run.settledAt || Date.now() >= run.expiresAt) {
        await this.stop(run, 'deadline', run.state !== 'starting' && run.outcome !== 'start_failed')
      } else await this.ctx.storage.setAlarm(run.expiresAt)
    })
  }
}
