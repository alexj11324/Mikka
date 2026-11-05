import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, before, beforeEach, mock, test } from 'node:test'

// The real arm, workflow, steps and owner checks run against an SDK boundary
// recorder. No database, Vercel world, model or production workflow is called.
const TOKEN = 'due-timer:run-recovery'
const NAME = 'workflow//./workflows/due-timer/workflow//dueTimer'
type Context = { runId: string; deploymentId: string }
type Row = { runId: string; deploymentId: string; workflowName: string; status: string; specVersion: number; startedAt: Date; createdAt: Date }
type HookRow = { runId: string; hookId: string; token: string; ownerId: string; projectId: string; environment: string;
  resumeContext: { deploymentId: string; workflowName: string; runSpecVersion: number };
  claimedFrom?: { runId: string; hookId: string; deploymentId: string; workflowName: string; runSpecVersion: number } }
type Pending = { resolve(value: unknown): void; reject(error: Error): void }
const context = new AsyncLocalStorage<Context>()
const hooks = new Map<string, HookRow>(), byId = new Map<string, HookRow>(), runs = new Map<string, Row>()
const deliveries = new Map<string, Pending[]>(), buffered = new Map<string, unknown[]>(), lost = new Map<string, Error>()
const completions: Promise<void>[] = [], failures: unknown[] = []
const activity = new Map<string, 'running' | 'waiting' | 'done'>()
const observers = new Set<() => void>()
let closing = false
const trace: { event: string; runId?: string; token?: string; deploymentId?: string; force?: boolean }[] = []
let latest = 'new', caller = 'new', environment = 'production', resolver = true, next: number | null = null
let serial = 0, jobs = 0, legacyJobs = 0, nextReads = 0, lookupFailure = false, cancelFailure = false, startFailure = false
let beforeForce: (() => void) | undefined
let afterForce: (() => void) | undefined
let dueTimer: typeof import('./workflow').dueTimer, armDueTimer: typeof import('@/lib/due-timer').armDueTimer
const previousEnvironment = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV }

const error = (name: string, token?: string) => Object.assign(new Error('synthetic private transport text'), { name, token })
const active = (runId: string) => ['pending', 'running'].includes(runs.get(runId)?.status ?? '')
const row = (runId: string, deploymentId = 'new', workflowName = NAME): Row => ({ runId, deploymentId, workflowName, status: 'running', specVersion: 8, startedAt: new Date(), createdAt: new Date() })
function seed(runId: string, deploymentId: string, fields: Partial<HookRow> = {}) {
  const run = runs.get(runId) ?? row(runId, deploymentId)
  runs.set(runId, run)
  const value: HookRow = { runId, hookId: `hook-${++serial}`, token: TOKEN, ownerId: 'test-owner', projectId: 'test-project', environment,
    resumeContext: { deploymentId, workflowName: run.workflowName, runSpecVersion: run.specVersion }, ...fields }
  hooks.set(value.token, value); byId.set(value.hookId, value)
  return value
}
function note(runId: string, state: 'running' | 'waiting' | 'done') {
  if (!activity.has(runId)) return
  activity.set(runId, state)
  for (const observe of observers) observe()
}
function until(observed: () => boolean, description: string): Promise<void> {
  if (observed()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(deadline); observers.delete(check); resolve() }
    const check = () => { if (observed()) finish() }
    const deadline = setTimeout(() => {
      observers.delete(check)
      reject(new Error(`Recorder did not reach ${description}`))
    }, 10_000)
    observers.add(check)
  })
}
function deliver(hook: HookRow, value: unknown) {
  const waiting = deliveries.get(hook.hookId)?.shift()
  if (waiting) { note(hook.runId, 'running'); waiting.resolve(value) }
  else buffered.set(hook.hookId, [...(buffered.get(hook.hookId) ?? []), value])
}
function displace(hook: HookRow) {
  const failure = error('HookForceClaimedError', hook.token)
  lost.set(hook.hookId, failure)
  const waiting = deliveries.get(hook.hookId) ?? []
  if (waiting.length) note(hook.runId, 'running')
  for (const pending of waiting) pending.reject(failure)
  deliveries.delete(hook.hookId)
}
function createHook(options: { token: string; experimental_force?: boolean }) {
  if (closing) throw error('HookForceClaimedError', options.token)
  const current = context.getStore()!
  if (options.experimental_force) beforeForce?.()
  const previous = hooks.get(options.token)
  const conflict = previous && active(previous.runId) && (!options.experimental_force || previous.resumeContext.runSpecVersion < 8)
  const value = conflict ? undefined : seed(current.runId, current.deploymentId, { token: options.token,
    ...(previous && options.experimental_force ? { claimedFrom: { runId: previous.runId, hookId: previous.hookId,
      deploymentId: previous.resumeContext.deploymentId, workflowName: previous.resumeContext.workflowName,
      runSpecVersion: previous.resumeContext.runSpecVersion } } : {}) })
  trace.push({ event: 'create', runId: current.runId, token: options.token, force: options.experimental_force === true })
  if (value && previous && options.experimental_force) displace(previous)
  if (options.experimental_force) afterForce?.()
  const nextPayload = () => new Promise<unknown>((resolve, reject) => {
    if (!value) { reject(error('HookConflictError', options.token)); return }
    const queue = buffered.get(value.hookId)
    if (queue?.length) { resolve(queue.shift()); return }
    const failure = lost.get(value.hookId)
    if (failure) { reject(failure); return }
    deliveries.set(value.hookId, [...(deliveries.get(value.hookId) ?? []), { resolve, reject }])
    note(value.runId, 'waiting')
  })
  return Object.assign(new Promise<unknown>(() => {}), {
    // The production owner loop consumes the SDK's AsyncIterable interface,
    // so repeated notifications remain distinct without inventing a thenable.
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: await nextPayload() }) }),
    getConflict: async () => conflict ? { runId: previous!.runId } : null,
    dispose: () => { trace.push({ event: 'dispose', runId: current.runId, token: options.token }); if (value && hooks.get(options.token)?.hookId === value.hookId) hooks.delete(options.token) },
  })
}
async function lookup(token: string) {
  if (lookupFailure) throw error('WorkflowWorldError')
  const value = hooks.get(token)
  if (!value) throw error('HookNotFoundError', token)
  return structuredClone(value)
}
async function resume(token: string) {
  const value = await lookup(token)
  if (!active(value.runId)) throw error('RunExpiredError', token)
  trace.push({ event: 'resume', runId: value.runId, token })
  if (value.runId === 'legacy') legacyJobs++
  deliver(value, {})
  return value
}
function launch(runId: string, deploymentId = 'new', kind: Parameters<typeof dueTimer>[0] = 'run-recovery', predecessorRunId?: string) {
  runs.set(runId, row(runId, deploymentId))
  activity.set(runId, 'running')
  const invoke = dueTimer as (kind: Parameters<typeof dueTimer>[0], predecessorRunId?: string) => Promise<void>
  const completion = context.run({ runId, deploymentId }, () => invoke(kind, predecessorRunId)).catch(cause => {
    if (!(cause instanceof Error) || cause.name !== 'HookForceClaimedError') failures.push(cause)
  }).finally(() => {
    for (const [token, hook] of hooks) if (hook.runId === runId) hooks.delete(token)
    note(runId, 'done')
  })
  completions.push(completion)
}
// Dynamic imports cross the event loop. Wait for each launched workflow to
// actually suspend on its recorded hook or finish, rather than counting ticks.
async function settle() {
  await until(() => [...activity.values()].every(state => state !== 'running'), 'a hook wait or completion')
}
function forced() { return trace.filter(item => item.event === 'create' && item.force) }
function cancelled() { return trace.filter(item => item.event === 'cancel').map(item => item.runId) }
function started() { return trace.filter(item => item.event === 'start') }

mock.module('workflow', { namedExports: {
  createHook,
  sleep: (at: Date) => { trace.push({ event: `sleep:${at.getTime()}` }); return new Promise<void>(() => {}) },
  getWorkflowMetadata: () => ({ workflowName: NAME, workflowRunId: context.getStore()!.runId, workflowStartedAt: new Date(0), url: 'https://fixture.invalid', features: { encryption: true } }),
  RetryableError: class RetryableError extends Error {},
} })
mock.module('workflow/runtime', { namedExports: { getWorld: async () => ({
  getEnvironment: () => environment,
  getDeploymentId: async () => context.getStore()?.deploymentId ?? caller,
  ...(resolver ? { resolveLatestDeploymentId: async () => latest } : {}),
  runs: { get: async (runId: string, options: { resolveData: string }) => {
    assert.equal(options.resolveData, 'none'); const value = runs.get(runId)
    if (!value) throw error('WorkflowRunNotFoundError')
    return structuredClone(value)
  } },
  hooks: { get: async (hookId: string, options?: { resolveData: string }) => {
    if (options) assert.equal(options.resolveData, 'none')
    const value = byId.get(hookId); if (!value) throw error('HookNotFoundError')
    return structuredClone(value)
  }, getByToken: lookup },
}) } })
mock.module('workflow/api', { namedExports: {
  getHookByToken: lookup, resumeHook: resume,
  getRun: (runId: string) => ({ cancel: async () => {
    trace.push({ event: 'cancel', runId })
    if (cancelFailure) throw error('WorkflowWorldError')
    runs.get(runId)!.status = 'cancelled'
  } }),
  start: async (_workflow: unknown, args: [Parameters<typeof dueTimer>[0], string?], options?: { deploymentId?: string }) => {
    if (closing) throw error('HookForceClaimedError', TOKEN)
    const deploymentId = options?.deploymentId === 'latest' ? latest : options?.deploymentId ?? context.getStore()?.deploymentId ?? caller
    const runId = `candidate-${++serial}`
    trace.push({ event: 'start', runId, deploymentId: options?.deploymentId })
    if (startFailure) throw error('WorkflowWorldError')
    launch(runId, deploymentId, args[0], args[1])
    return { runId }
  },
} })
mock.module(new URL('../../lib/run-recovery.ts', import.meta.url).href, { namedExports: { recoverRuns: async () => { jobs++; return {} } } })
mock.module(new URL('../../lib/run-recovery-due.ts', import.meta.url).href, { namedExports: {
  runRecoveryPass: async () => { jobs++; nextReads++; return next },
  runRecoveryNextDue: async () => { nextReads++; return next },
} })

before(async () => {
  ;({ dueTimer } = await import('./workflow'))
  // This is the metadata normally added by the SDK transform; the Node test
  // executes the source function directly rather than compiling a deployment.
  Object.assign(dueTimer, { workflowId: NAME })
  ;({ armDueTimer } = await import('@/lib/due-timer'))
})
beforeEach(() => {
  hooks.clear(); byId.clear(); runs.clear(); deliveries.clear(); buffered.clear(); lost.clear()
  completions.length = 0; failures.length = 0; trace.length = 0
  activity.clear(); observers.clear(); closing = false
  latest = 'new'; caller = 'new'; environment = 'production'; resolver = true; next = null
  serial = 0; jobs = 0; legacyJobs = 0; nextReads = 0; lookupFailure = false; cancelFailure = false; startFailure = false
  beforeForce = undefined; afterForce = undefined
  process.env.VERCEL = '1'; process.env.VERCEL_ENV = 'production'
})
afterEach(async () => {
  // Stop late imports from creating a new hook after the cleanup snapshot.
  closing = true
  try {
    for (const hook of hooks.values()) displace(hook)
    await until(() => [...activity.values()].every(state => state === 'done'), 'cleanup completion')
    await Promise.all(completions)
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    mock.timers.reset()
  }
})

test('normal production arm replaces the old deployment timer before the next recovery pass', async () => {
  seed('legacy', 'old')
  await armDueTimer('run-recovery'); await settle()
  assert.equal(legacyJobs, 0, 'arm must inspect the owner before waking old business code')
  assert.deepEqual(started().map(item => item.deploymentId), ['latest'])
  assert.deepEqual(cancelled(), ['legacy'])
  assert.equal(forced().length, 1)
  assert.equal(jobs, 1)
  assert.equal(hooks.get(TOKEN)?.resumeContext.deploymentId, 'new')
  assert.deepEqual(failures, [])
})

test('concurrent same-deployment candidates elect one owner and cancel only the legacy timer', async () => {
  seed('legacy', 'old')
  launch('one'); launch('two'); await settle()
  assert.equal(forced().length, 1)
  assert.deepEqual(cancelled(), ['legacy'])
  assert.equal(jobs, 1)
  assert.equal(hooks.get(TOKEN)?.runId, 'one')
  assert.deepEqual(failures, [])
})

test('idle ownership has no query or sleep and absorbs a cancelled old step late arm', async () => {
  seed('legacy', 'old'); launch('one'); await settle()
  const reads = nextReads, passes = jobs, sleeps = trace.filter(item => item.event.startsWith('sleep:')).length
  assert.equal(hooks.get(TOKEN)?.runId, 'one', 'no-due must retain the global token')
  await settle()
  assert.equal(nextReads, reads); assert.equal(jobs, passes)
  assert.equal(trace.filter(item => item.event.startsWith('sleep:')).length, sleeps)
  // This is precisely what already-running pre-fix arm code can still do
  // after its parent was cancelled. It must find the current holder, not an
  // empty token and start another old-deployment timer.
  await resume(TOKEN); await settle()
  assert.equal(jobs, passes + 1)
  assert.equal(started().length, 0)
  assert.equal(legacyJobs, 0)
})

test('same-deployment lifetime handoff keeps global ownership and admits one exact successor', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) })
  launch('one'); await settle(); mock.timers.tick(7 * 60 * 60_000)
  await armDueTimer('run-recovery'); await settle()
  assert.notEqual(hooks.get(TOKEN)?.runId, 'one')
  assert.equal(hooks.get(TOKEN)?.resumeContext.deploymentId, 'new')
  assert.equal(started().length, 1); assert.deepEqual(cancelled(), ['one'])
  assert.equal(jobs, 2)
  const claim = trace.findIndex(item => item.event === 'create' && item.force && item.runId !== 'one')
  const release = trace.findIndex(item => item.event === 'dispose' && item.token === TOKEN && item.runId === 'one')
  assert.ok(claim >= 0 && (release < 0 || release > claim))
})

test('failed lifetime handoff keeps the global hook and retries only on a real later wake', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) })
  launch('one'); await settle(); mock.timers.tick(7 * 60 * 60_000)
  startFailure = true; await resume(TOKEN); await settle()
  assert.equal(hooks.get(TOKEN)?.runId, 'one')
  assert.equal(jobs, 1); assert.equal(started().length, 1)
  const reads = nextReads
  await settle(); assert.equal(started().length, 1); assert.equal(nextReads, reads)
  startFailure = false; await resume(TOKEN); await settle()
  assert.notEqual(hooks.get(TOKEN)?.runId, 'one')
  assert.deepEqual(cancelled(), ['one']); assert.equal(jobs, 2)
})

test('late or premature same-deployment successors cannot force a fresh winner', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) })
  seed('winner', 'new')
  launch('premature', 'new', 'run-recovery', 'winner'); await settle()
  assert.equal(forced().length, 0); assert.deepEqual(cancelled(), [])
  launch('late', 'new', 'run-recovery', 'previous-owner'); await settle()
  assert.equal(forced().length, 0); assert.deepEqual(cancelled(), [])
  assert.equal(hooks.get(TOKEN)?.runId, 'winner')
})

test('a real wake after a deployment change transfers without releasing the global token', async () => {
  launch('one'); await settle(); latest = 'next'
  const before = jobs
  await resume(TOKEN); await settle()
  assert.deepEqual(started().map(item => item.deploymentId), ['latest'])
  assert.equal(hooks.get(TOKEN)?.resumeContext.deploymentId, 'next')
  assert.deepEqual(cancelled(), ['one'])
  assert.equal(jobs, before + 1, 'only the new deployment may do the next pass')
  const replacement = trace.findIndex(item => item.event === 'create' && item.force && item.runId !== 'one')
  const release = trace.findIndex(item => item.event === 'dispose' && item.token === TOKEN && item.runId === 'one')
  assert.ok(replacement >= 0 && (release < 0 || release > replacement))
  assert.deepEqual(failures, [])
})

test('stale candidate never force-claims or cancels the current deployment', async () => {
  seed('winner', 'new'); launch('stale', 'old'); await settle()
  assert.equal(forced().filter(item => item.runId === 'stale').length, 0)
  assert.equal(cancelled().includes('winner'), false)
  assert.equal(legacyJobs, 0)
})

test('unsupported, foreign and unknown owners are never force-claimed or cancelled', async t => {
  for (const invalid of ['preview', 'project', 'owner', 'workflow', 'spec'] as const) await t.test(invalid, async () => {
    hooks.clear(); byId.clear(); runs.clear(); trace.length = 0; failures.length = 0
    const holder = seed('protected', 'old')
    if (invalid === 'preview') holder.environment = 'preview'
    if (invalid === 'project') holder.projectId = 'another-project'
    if (invalid === 'owner') holder.ownerId = 'another-owner'
    if (invalid === 'workflow') { holder.resumeContext.workflowName = 'workflow//native//child'; runs.get('protected')!.workflowName = holder.resumeContext.workflowName }
    if (invalid === 'spec') { holder.resumeContext.runSpecVersion = 7; runs.get('protected')!.specVersion = 7 }
    launch(`candidate-${invalid}`); await settle()
    assert.equal(forced().length, 0); assert.deepEqual(cancelled(), [])
    assert.equal(hooks.get(TOKEN)?.runId, 'protected')
  })
})

test('a changed claimedFrom victim cannot authorize cancelling a native child', async () => {
  seed('legacy', 'old')
  beforeForce = () => { beforeForce = undefined; const child = seed('native-child', 'old'); child.resumeContext.workflowName = 'workflow//native//child'; runs.get('native-child')!.workflowName = child.resumeContext.workflowName }
  launch('one'); await settle()
  assert.equal(cancelled().includes('native-child'), false)
  assert.equal(jobs, 0)
})

test('a captured predecessor that finishes before force needs no cancellation receipt', async () => {
  seed('legacy', 'old')
  beforeForce = () => {
    beforeForce = undefined
    runs.get('legacy')!.status = 'completed'
    hooks.delete(TOKEN)
  }
  launch('one'); await settle()
  assert.equal(hooks.get(TOKEN)?.runId, 'one')
  assert.deepEqual(cancelled(), []); assert.equal(jobs, 1)
  assert.deepEqual(failures, [])
})

test('loss after force never cancels the new winner or runs stale work', async () => {
  seed('legacy', 'old')
  afterForce = () => { afterForce = undefined; seed('winner', 'new') }
  launch('one'); await settle()
  assert.deepEqual(cancelled(), []); assert.equal(jobs, 0)
  assert.equal(hooks.get(TOKEN)?.runId, 'winner')
})

test('unknown lookup and missing latest capability do not become no-owner starts', async () => {
  const original = console.error, logged: unknown[][] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    lookupFailure = true; await armDueTimer('run-recovery')
    lookupFailure = false; resolver = false; await armDueTimer('run-recovery')
  } finally { console.error = original }
  assert.equal(started().length, 0); assert.deepEqual(cancelled(), [])
  assert.equal(JSON.stringify(logged).includes('private'), false)
})

test('cancel failure prevents due work and never touches the native task', async () => {
  seed('legacy', 'old'); runs.set('native-child', row('native-child', 'old', 'workflow//native//child'))
  cancelFailure = true; launch('one'); await settle()
  assert.deepEqual(cancelled(), ['legacy']); assert.equal(jobs, 0)
  assert.equal(runs.get('native-child')?.status, 'running')
})

test('preview run-recovery keeps the existing non-force lifecycle', async () => {
  environment = 'preview'; process.env.VERCEL_ENV = 'preview'
  launch('preview'); await settle()
  assert.equal(jobs, 1); assert.equal(hooks.has(TOKEN), false)
  assert.equal(forced().length, 0); assert.deepEqual(cancelled(), [])
})
