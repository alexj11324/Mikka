import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { before, beforeEach, mock, test } from 'node:test'

// The installed Workflow 5.2.3 transport contract: a forced hook claim changes
// the token atomically and rejects the previous hook's present/future awaits.
// A cancelled Workflow may still have one already-running step complete.
const context = new AsyncLocalStorage<string>()
class Forced extends Error {
  constructor() { super('fixture takeover'); this.name = 'HookForceClaimedError' }
  static is(value: unknown) { return value instanceof Forced }
}
const holders = new Map<string, FakeHook>()
const sleeps: Array<{ owner: string; at: number; resolve(): void }> = []
const retired: string[] = []
const trace: string[] = []
class FakeHook {
  readonly owner = context.getStore()!
  private pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = []
  private payloads: unknown[] = []
  private forced = false
  private inFlight: Promise<unknown> | undefined
  constructor(readonly token: string, private readonly force = false) {}
  async getConflict() {
    const previous = holders.get(this.token)
    if (previous && previous !== this) {
      if (!this.force) return { runId: previous.owner }
      previous.lose()
    }
    holders.set(this.token, this)
    return null
  }
  dispose() { if (holders.get(this.token) === this) holders.delete(this.token) }
  lose() { this.forced = true; for (const waiter of this.pending.splice(0)) waiter.reject(new Forced()) }
  wake() {
    const waiter = this.pending.shift()
    if (waiter) waiter.resolve({})
    else this.payloads.push({})
  }
  // oxlint-disable-next-line unicorn/no-thenable -- Workflow Hooks deliberately consume one queued event per await.
  then<T>(resolve: (value: unknown) => T, reject: (error: unknown) => T) {
    if (!this.inFlight) {
      const promise = this.forced ? Promise.reject(new Forced()) : this.payloads.length ? Promise.resolve(this.payloads.shift()) : new Promise((yes, no) => { this.pending.push({ resolve: yes, reject: no }) })
      this.inFlight = promise
      void promise.then(() => { if (this.inFlight === promise) this.inFlight = undefined }, () => { if (this.inFlight === promise) this.inFlight = undefined })
    }
    return this.inFlight.then(resolve, reject)
  }
}
mock.module('workflow', { namedExports: {
  createHook: (options: { token: string; experimental_force?: boolean }) => new FakeHook(options.token, options.experimental_force),
  sleep: (at: Date) => new Promise<void>(resolve => { sleeps.push({ owner: context.getStore()!, at: at.getTime(), resolve }) }),
} })
mock.module('workflow/errors', { namedExports: { HookForceClaimedError: Forced } })
mock.module(new URL('../wake.ts', import.meta.url).href, { namedExports: { nudgeWorkflow: async (token: string) => { trace.push(`nudge:${holders.get(token)?.owner}`); holders.get(token)?.wake() } } })
let runDueTimer: typeof import('./loop').runDueTimer
let lifetime: number
before(async () => { ({ runDueTimer, DUE_TIMER_LIFETIME_MS: lifetime } = await import('./loop')) })
beforeEach(() => { holders.clear(); sleeps.length = 0; retired.length = 0; trace.length = 0; mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) }) })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const token = 'due-timer:run-recovery'
function dependencies(owner: string, previous?: string) {
  return {
    prepareClaim: async () => {
      const holder = holders.get(token)
      if (!holder) return { mode: 'acquire' as const }
      if (holder.owner === 'old-08b' || holder.owner === previous) return { mode: 'acquire' as const, force: true, previousRunId: holder.owner }
      return { mode: 'yield' as const }
    },
    completeClaim: async (id?: string) => { if (id) retired.push(id) },
    run: async () => { trace.push(`run:${owner}`); return null },
    next: async () => null,
    handOff: async () => { trace.push(`handoff:${owner}`) },
  }
}
function launch(owner: string, previous?: string) {
  let finished = false
  const done = context.run(owner, () => runDueTimer(token, dependencies(owner, previous))).finally(() => { finished = true })
  // Cleanup observes the result even when the RED implementation ends early.
  void done.catch(() => {})
  return { done, finished: () => finished }
}
async function stop(owner: string, done: Promise<unknown>) {
  for (const hook of holders.values()) if (hook.owner === owner) hook.lose()
  await done.catch(error => { if (!Forced.is(error)) throw error })
}

test('an idle latest holder fences an old in-flight pass and its late afterCommit/retake', async () => {
  const old = context.run('old-08b', () => new FakeHook(token))
  assert.equal(await old.getConflict(), null)
  const latest = launch('latest')
  try {
    await flush()
    assert.equal(holders.get(token)?.owner, 'latest', 'old deployment is replaced before any latest business work')
    assert.deepEqual(retired, ['old-08b'])
    assert.deepEqual(trace.filter(x => x.startsWith('run:')), ['run:latest'])
    assert.equal(latest.finished(), false, 'no due work must retain the token; idle is not a release window')
    // Exact old08b null branch: dispose its old handle, next() finds work,
    // ordinary take must see the latest holder and cannot run old work.
    old.dispose()
    const oldRetake = context.run('old-08b', () => new FakeHook(token))
    assert.equal((await oldRetake.getConflict())?.runId, 'latest')
    oldRetake.dispose()
    // An already-running old step can still finish its afterCommit callback.
    holders.get(token)!.wake()
    await flush()
    assert.equal(holders.get(token)?.owner, 'latest')
    assert.deepEqual(trace.filter(x => x.startsWith('run:')), ['run:latest', 'run:latest'])
  } finally { await stop('latest', latest.done) }
})

test('the lifetime handoff keeps the global token until the identified successor takes it', async () => {
  const parent = launch('parent')
  let child: ReturnType<typeof launch> | undefined
  try {
    await flush()
    assert.equal(holders.get(token)?.owner, 'parent')
    assert.deepEqual(sleeps, [], 'an idle holder waits for writes, with no periodic DB sweep')
    mock.timers.tick(lifetime)
    holders.get(token)!.wake()
    await flush()
    assert.ok(trace.includes('handoff:parent'))
    assert.equal(holders.get(token)?.owner, 'parent', 'enqueueing the successor is not a completed handoff')
    holders.get(token)!.wake()
    await flush()
    assert.equal(parent.finished(), false, 'an ordinary wake is not a takeover acknowledgement')
    assert.equal(holders.get(token)?.owner, 'parent')
    child = launch('child', 'parent')
    await flush()
    assert.equal(holders.get(token)?.owner, 'child')
    assert.ok(retired.includes('parent'))
    await parent.done
    assert.equal(holders.get(token)?.owner, 'child', 'old cleanup must not dispose its successor')
  } finally {
    await stop('parent', parent.done)
    if (child) await stop('child', child.done)
  }
})

test('concurrent latest candidates serialize inspection and never force an already-current holder', async () => {
  const old = context.run('old-08b', () => new FakeHook(token))
  await old.getConflict()
  const first = launch('latest-one')
  const second = launch('latest-two')
  try {
    await flush()
    assert.equal(holders.get(token)?.owner, 'latest-one')
    assert.deepEqual(retired, ['old-08b'])
    assert.equal(second.finished(), true)
    assert.equal(first.finished(), false)
    assert.ok(!trace.includes('run:latest-two'))
  } finally { await stop('latest-one', first.done); await stop('latest-two', second.done) }
})


test('a failed predecessor retirement does no business work and releases its election', async () => {
  const old = context.run('old-08b', () => new FakeHook(token))
  await old.getConflict()
  const error = new Error('fixture cancellation refused')
  const done = context.run('latest', () => runDueTimer(token, {
    ...dependencies('latest'), completeClaim: async () => { throw error },
  }))
  await assert.rejects(done, value => value === error)
  assert.deepEqual(trace.filter(x => x.startsWith('run:')), [])
  assert.equal(holders.has(token + ':claim'), false)
})

test('a lifetime successor that loses the election is retried after the yielding candidate releases it', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const children: ReturnType<typeof launch>[] = []
  const parent = context.run('parent', () => runDueTimer(token, {
    ...dependencies('parent'),
    handOff: async () => { trace.push('handoff:parent'); children.push(launch(`child-${children.length}`, 'parent')) },
  }))
  void parent.catch(() => {})
  let competitor: Promise<unknown> | undefined
  try {
    await flush()
    competitor = context.run('competing-candidate', () => runDueTimer(token, {
      ...dependencies('competing-candidate'),
      prepareClaim: async () => { enter(); await gate; return { mode: 'yield', wake: true } },
    }))
    await entered
    mock.timers.tick(lifetime)
    holders.get(token)!.wake()
    await flush()
    assert.equal(children.length, 1)
    assert.equal(children[0].finished(), true, 'the first successor lost the short election')
    assert.equal(holders.get(token)?.owner, 'parent')
    release()
    await competitor
    await flush()
    assert.equal(children.length, 2, 'the post-election wake must retry the legitimate handoff')
    assert.equal(holders.get(token)?.owner, 'child-1')
    await parent
    assert.equal(holders.has(token + ':claim'), false)
  } finally {
    release()
    if (competitor) await competitor
    await stop('parent', parent)
    for (const [index, child] of children.entries()) await stop(`child-${index}`, child.done)
  }
})
