import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, mock, test } from 'node:test'
import * as workflow from 'workflow'
import { HookNotFoundError } from 'workflow/errors'

// Record the installed public SDK boundary. No Workflow world, database or network is started.
const TOKEN = 'due-timer:run-recovery'
const WORKFLOW_NAME = 'workflow//./workflows/due-timer/workflow//dueTimer'
const LATEST_DEPLOYMENT = 'dpl_latest'
const PREDECESSOR_RUN = 'wrun_predecessor'
type Holder = {
  hookId: string
  token: string
  runId: string
  specVersion: number
  claimedFrom?: { runId: string }
  resumeContext?: { deploymentId: string; workflowName: string }
}
const starts: Array<{ workflow: unknown; args: unknown[]; options: unknown }> = []
const resumes: Array<{ token: string; payload: unknown }> = []
const hookLookups: string[] = []
const runMetadataReads: Array<{ runId: string; options: unknown }> = []
const cancellations: string[] = []
type RunMetadata = { runId: string; deploymentId: string; workflowName: string; status: string; attributes?: { $parentRunId: string } }
const runRecords = new Map<string, RunMetadata>()
const statusReads: string[] = []
const cancellationErrors = new Map<string, Error>()
const cancellationLeavesRunning = new Set<string>()
let forceSupported = true
let holder: Holder | undefined
let lookupError: Error | undefined
let currentDeployment = LATEST_DEPLOYMENT
let latestDeployment = LATEST_DEPLOYMENT
let fallbackDeployment = 'dpl_old'
let workflowRunId = PREDECESSOR_RUN

function heldBy(deploymentId: string, runId = 'wrun_holder'): Holder {
  return { hookId: 'hook_' + runId, token: TOKEN, runId, specVersion: 8, resumeContext: { deploymentId, workflowName: WORKFLOW_NAME } }
}

mock.module('workflow/api', { namedExports: {
  getHookByToken: async (token: string) => {
    hookLookups.push(token)
    if (lookupError) throw lookupError
    if (!holder) throw new HookNotFoundError(token)
    return holder
  },
  resumeHook: async (token: string, payload: unknown) => {
    resumes.push({ token, payload })
    if (!holder) throw new HookNotFoundError(token)
    return holder
  },
  start: async (fn: unknown, args: unknown[], options?: unknown) => {
    starts.push({ workflow: fn, args: [...args], options })
    return { runId: 'wrun_candidate' }
  },
  getRun: (runId: string) => ({
    runId,
    cancel: async () => {
      cancellations.push(runId)
      const error = cancellationErrors.get(runId)
      if (error) throw error
      const run = runRecords.get(runId)
      assert.ok(run, 'cancellation must target known SDK metadata')
      if (!cancellationLeavesRunning.has(runId)) run.status = 'cancelled'
    },
    get status() {
      statusReads.push(runId)
      const run = runRecords.get(runId)
      assert.ok(run, 'status must be read for a known run')
      return Promise.resolve(run.status)
    },
  }),
} })
mock.module('workflow/runtime', { namedExports: {
  getWorld: async () => ({
    capabilities: { hookForceClaim: forceSupported },
    getDeploymentId: async () => currentDeployment,
    resolveLatestDeploymentId: async () => latestDeployment,
    runs: { get: async (runId: string, options: unknown) => {
      runMetadataReads.push({ runId, options })
      const run = runRecords.get(runId)
      if (run) return { ...run }
      assert.equal(runId, holder?.runId, 'only the actual holder may use legacy metadata fallback')
      return { runId, deploymentId: fallbackDeployment, workflowName: WORKFLOW_NAME, status: 'running' }
    } },
  }),
} })
mock.module('workflow', { namedExports: {
  ...workflow,
  getWorkflowMetadata: () => ({ workflowRunId, workflowName: WORKFLOW_NAME }),
} })

let armDueTimer: typeof import('./due-timer').armDueTimer
let dueTimerTransport: typeof import('./due-timer').dueTimerTransport
let wakeTransport: typeof import('./workflow-wake').wakeTransport
let handOffDueTimer: typeof import('../workflows/due-timer/steps').handOffDueTimer
let dueTimer: typeof import('../workflows/due-timer/workflow').dueTimer
let prepareTimerClaim: typeof import('./due-timer-deployment').prepareTimerClaim
let completeTimerClaim: typeof import('./due-timer-deployment').completeTimerClaim
before(async () => {
  ;({ armDueTimer, dueTimerTransport } = await import('./due-timer'))
  ;({ wakeTransport } = await import('./workflow-wake'))
  ;({ handOffDueTimer } = await import('../workflows/due-timer/steps'))
  ;({ dueTimer } = await import('../workflows/due-timer/workflow'))
  ;({ prepareTimerClaim, completeTimerClaim } = await import('./due-timer-deployment'))
})

const ENV_KEYS = ['VERCEL', 'VERCEL_ENV', 'VERCEL_DEPLOYMENT_ID', 'WORKFLOW_TARGET_WORLD'] as const
let savedEnvironment: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnvironment = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  starts.length = resumes.length = hookLookups.length = runMetadataReads.length = cancellations.length = statusReads.length = 0
  runRecords.clear()
  cancellationErrors.clear()
  cancellationLeavesRunning.clear()
  forceSupported = true
  holder = heldBy(LATEST_DEPLOYMENT)
  lookupError = undefined
  currentDeployment = latestDeployment = LATEST_DEPLOYMENT
  fallbackDeployment = 'dpl_old'
  workflowRunId = PREDECESSOR_RUN
})
afterEach(() => {
  delete wakeTransport.resume
  delete dueTimerTransport.start
  for (const key of ENV_KEYS) {
    const value = savedEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function hosted() {
  process.env.VERCEL = '1'
  process.env.VERCEL_ENV = 'production'
  process.env.VERCEL_DEPLOYMENT_ID = currentDeployment
}
function assertLatestStart(args: unknown[]) {
  assert.equal(starts.length, 1)
  assert.equal(starts[0].workflow, dueTimer)
  assert.deepEqual(starts[0].args, args)
  assert.deepEqual(starts[0].options, { deploymentId: 'latest' })
  assert.deepEqual(cancellations, [], 'arming must not cancel the incumbent before its successor owns the token')
}

test('a running timer is woken and no second one is started', async () => {
  const calls: string[] = []
  wakeTransport.resume = async token => { calls.push(`resume:${token}`) }
  dueTimerTransport.start = async kind => { calls.push(`start:${kind}`) }
  await armDueTimer('schedules')
  assert.deepEqual(calls, ['resume:due-timer:schedules'])
})

test('with no timer holding the token, one is started', async () => {
  const calls: string[] = []
  wakeTransport.resume = async () => { calls.push('resume'); throw new Error('hook not found') }
  dueTimerTransport.start = async kind => { calls.push(`start:${kind}`) }
  await armDueTimer('schedules')
  assert.deepEqual(calls, ['resume', 'start:schedules'])
})

test('a failed start never fails the write that armed it', async () => {
  wakeTransport.resume = async () => { throw new Error('hook not found') }
  dueTimerTransport.start = async () => { throw new Error('private transport text') }
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try { await armDueTimer('schedules') } finally { console.error = original }
  assert.equal(JSON.stringify(logged).includes('private'), false)
})


test('a hook held by the old deployment starts a latest candidate without waking or cancelling the old holder', async () => {
  hosted()
  holder = heldBy('dpl_old', 'wrun_08b')
  await armDueTimer('run-recovery')
  assertLatestStart(['run-recovery'])
  assert.deepEqual(resumes, [])
})

test('a holder already on the latest deployment is only woken', async () => {
  hosted()
  await armDueTimer('run-recovery')
  assert.deepEqual(resumes, [{ token: TOKEN, payload: {} }])
  assert.deepEqual(starts, [])
  assert.deepEqual(cancellations, [])
})

test('a late caller on an older deployment does not replace a holder already on the latest target', async () => {
  currentDeployment = 'dpl_old'
  hosted()
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_latest')
  await armDueTimer('run-recovery')
  assert.deepEqual(resumes, [{ token: TOKEN, payload: {} }])
  assert.deepEqual(starts, [])
  assert.deepEqual(cancellations, [])
})

test('a missing global hook starts the current production target explicitly', async () => {
  hosted()
  holder = undefined
  await armDueTimer('run-recovery')
  assertLatestStart(['run-recovery'])
})

test('legacy hook metadata is resolved from the owning run without loading run data', async () => {
  hosted()
  holder = heldBy('dpl_old', 'wrun_legacy')
  delete holder.resumeContext
  await armDueTimer('run-recovery')
  assert.deepEqual(runMetadataReads, [{ runId: 'wrun_legacy', options: { resolveData: 'none' } }])
  assertLatestStart(['run-recovery'])
  assert.deepEqual(resumes, [])
})

test('repeated writes after a latest holder has taken over do not start more candidates', async () => {
  hosted()
  holder = heldBy('dpl_old', 'wrun_08b')
  await armDueTimer('run-recovery')
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_latest')
  await armDueTimer('run-recovery')
  await armDueTimer('run-recovery')
  assertLatestStart(['run-recovery'])
  assert.deepEqual(resumes, [{ token: TOKEN, payload: {} }, { token: TOKEN, payload: {} }])
})

test('the lifetime handoff starts latest with the real predecessor identity and does not cancel it', async () => {
  hosted()
  workflowRunId = 'wrun_lifetime_cap'
  await handOffDueTimer('run-recovery')
  assertLatestStart(['run-recovery', 'wrun_lifetime_cap'])
  assert.deepEqual(resumes, [])
})

test('an unknown holder lookup failure does not leak private text or fail the write that armed it', async () => {
  hosted()
  lookupError = new Error('private holder lookup payload', { cause: new Error('private holder lookup cause') })
  const logged: unknown[][] = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]) => { logged.push(args) }
  console.warn = (...args: unknown[]) => { logged.push(args) }
  try { await assert.doesNotReject(armDueTimer('run-recovery')) } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  assert.deepEqual(hookLookups, [TOKEN], 'the metadata failure must actually be exercised')
  assert.equal(JSON.stringify(logged).includes('private'), false)
})


function recordRun(runId: string, deploymentId = LATEST_DEPLOYMENT, parentRunId?: string) {
  runRecords.set(runId, { runId, deploymentId, workflowName: WORKFLOW_NAME, status: 'running', ...(parentRunId ? { attributes: { $parentRunId: parentRunId } } : {}) })
}
function candidate(parentRunId?: string) {
  hosted()
  workflowRunId = 'wrun_candidate'
  recordRun(workflowRunId, LATEST_DEPLOYMENT, parentRunId)
}

test('a candidate re-reads a latest holder that replaced the old holder observed while arming', async () => {
  hosted()
  holder = heldBy('dpl_old', 'wrun_08b')
  await armDueTimer('run-recovery')
  assertLatestStart(['run-recovery'])
  candidate()
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_other_latest')
  assert.deepEqual(await prepareTimerClaim('run-recovery'), { mode: 'yield', wake: true })
  assert.equal(starts.length, 1)
  assert.deepEqual(cancellations, [])
})

test('an obsolete candidate yields to a latest successor without waking or cancelling the old holder', async () => {
  candidate()
  recordRun(workflowRunId, 'dpl_old')
  holder = heldBy('dpl_old', 'wrun_08b')
  assert.deepEqual(await prepareTimerClaim('run-recovery'), { mode: 'yield' })
  assertLatestStart(['run-recovery'])
  assert.deepEqual(resumes, [])
})

test('a caller-supplied predecessor cannot authorize force against a latest holder', async () => {
  candidate()
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_incumbent')
  assert.deepEqual(await prepareTimerClaim('run-recovery', 'wrun_incumbent'), { mode: 'yield', wake: true })
  recordRun(workflowRunId, LATEST_DEPLOYMENT, 'wrun_incumbent')
  assert.deepEqual(await prepareTimerClaim('run-recovery', 'wrun_some_other_parent'), { mode: 'yield', wake: true })
  assert.deepEqual(cancellations, [])
})

test('a same-deployment lifetime successor needs both the actual holder and its SDK-recorded parent', async () => {
  candidate('wrun_incumbent')
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_incumbent')
  assert.deepEqual(await prepareTimerClaim('run-recovery', 'wrun_incumbent'), { mode: 'acquire', force: true, previousRunId: 'wrun_incumbent' })
  assert.deepEqual(cancellations, [], 'the preparation step cannot retire a holder before claiming its token')
})

test('a candidate refuses takeover when the world or the old hook cannot support atomic force', async t => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  candidate()
  holder = heldBy('dpl_old', 'wrun_08b')
  let metadataReads = 0
  const privateText = 'private hook payload'
  Object.defineProperty(holder, 'metadata', { enumerable: true, get: () => { metadataReads++; return Promise.resolve(privateText) } })
  forceSupported = false
  await assert.rejects(prepareTimerClaim('run-recovery'), /due_timer_unavailable/)
  forceSupported = true
  holder.specVersion = 7
  await assert.rejects(prepareTimerClaim('run-recovery'), /due_timer_unavailable/)
  assert.deepEqual(cancellations, [])
  const diagnostics = warnings.map(args => {
    assert.equal(typeof args[0], 'string')
    return JSON.parse(String(args[0])) as Record<string, unknown>
  })
  assert.deepEqual(diagnostics.map(value => ({ code: value.code, detail: value.detail, kind: value.kind, spec: value.holderSpecVersion, forceSupported: value.forceSupported })), [
    { code: 'due_timer_unavailable', detail: 'force_unsupported', kind: 'run-recovery', spec: 8, forceSupported: false },
    { code: 'due_timer_unavailable', detail: 'force_unsupported', kind: 'run-recovery', spec: 7, forceSupported: true },
  ])
  assert.equal(metadataReads, 0, 'diagnostics must not hydrate private hook metadata')
  assert.equal(JSON.stringify(warnings).includes(privateText), false)
  assert.equal(JSON.stringify(warnings).includes(TOKEN), false)
})

test('a candidate that lost the global token cannot cancel its observed predecessor', async () => {
  candidate()
  holder = heldBy(LATEST_DEPLOYMENT, 'wrun_other_latest')
  recordRun('wrun_08b', 'dpl_old')
  await assert.rejects(completeTimerClaim('run-recovery', 'wrun_08b'), /due_timer_unavailable/)
  assert.deepEqual(cancellations, [])
  assert.equal(runRecords.get('wrun_08b')?.status, 'running')
})

test('the token owner confirms terminal status for both the observed and actual atomic displaced predecessors', async t => {
  t.mock.method(console, 'info', () => {})
  candidate()
  holder = heldBy(LATEST_DEPLOYMENT, workflowRunId)
  holder.claimedFrom = { runId: 'wrun_displaced' }
  recordRun('wrun_observed', 'dpl_old')
  recordRun('wrun_displaced', 'dpl_old')
  await completeTimerClaim('run-recovery', 'wrun_observed')
  assert.deepEqual([...cancellations].sort(), ['wrun_displaced', 'wrun_observed'])
  for (const id of cancellations) {
    assert.ok(statusReads.includes(id), 'cancellation requires a fresh terminal-status observation')
    assert.equal(runRecords.get(id)?.status, 'cancelled')
  }
  assert.equal(runRecords.get(workflowRunId)?.status, 'running')
  for (const read of runMetadataReads) assert.deepEqual(read.options, { resolveData: 'none' })
})

for (const failure of ['throws', 'stays-running'] as const) {
  test('a predecessor cancellation that ' + failure + ' cannot allow due work to continue', async () => {
    candidate()
    holder = heldBy(LATEST_DEPLOYMENT, workflowRunId)
    holder.claimedFrom = { runId: 'wrun_08b' }
    recordRun('wrun_08b', 'dpl_old')
    if (failure === 'throws') cancellationErrors.set('wrun_08b', new Error('synthetic cancellation failure'))
    else cancellationLeavesRunning.add('wrun_08b')
    let continued = false
    await assert.rejects((async () => {
      await completeTimerClaim('run-recovery', 'wrun_08b')
      continued = true
    })())
    assert.equal(continued, false)
    assert.deepEqual(cancellations, ['wrun_08b'])
    assert.equal(runRecords.get('wrun_08b')?.status, 'running')
    assert.equal(holder.runId, workflowRunId)
    assert.ok(statusReads.includes('wrun_08b'))
  })
}
