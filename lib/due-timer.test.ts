import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { armDueTimer, dueTimerTransport, forgetCheckedDueTimers, type DueTimerHolder } from './due-timer'
import { wakeTransport } from './workflow-wake'

const deployment = process.env.VERCEL_DEPLOYMENT_ID, vercelEnv = process.env.VERCEL_ENV
afterEach(() => {
  delete wakeTransport.resume; delete dueTimerTransport.start; delete dueTimerTransport.holder; delete dueTimerTransport.cancel
  delete dueTimerTransport.latestDeployment
  forgetCheckedDueTimers()
  if (deployment === undefined) delete process.env.VERCEL_DEPLOYMENT_ID; else process.env.VERCEL_DEPLOYMENT_ID = deployment
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = vercelEnv
})

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

/** A Workflow world in miniature: one token holder per kind, cancel ends it, a start takes the free token. */
function world(holder: DueTimerHolder | null) {
  const calls: string[] = []
  let live = holder
  dueTimerTransport.holder = async () => live
  dueTimerTransport.latestDeployment = async () => process.env.VERCEL_DEPLOYMENT_ID
  dueTimerTransport.cancel = async runId => { calls.push(`cancel:${runId}`); if (live?.runId === runId) live = null }
  dueTimerTransport.start = async kind => {
    calls.push(`start:${kind}`)
    if (!live) live = { runId: `run-${calls.length}`, deploymentId: process.env.VERCEL_DEPLOYMENT_ID! }
  }
  wakeTransport.resume = async token => { if (!live) throw new Error('hook not found'); calls.push(`resume:${token}`) }
  return { calls, live: () => live }
}

test('a timer run pinned to an older deployment is cancelled and replaced by one here (#1410)', async () => {
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new'
  const timer = world({ runId: 'run-old', deploymentId: 'dpl_old' })
  await armDueTimer('run-recovery')
  assert.deepEqual(timer.calls, ['cancel:run-old', 'start:run-recovery'])
  assert.equal(timer.live()?.deploymentId, 'dpl_new', 'exactly one live run, on this deployment')
  // Later arms in this process only wake it: no second cancel, no second start.
  await armDueTimer('run-recovery')
  await armDueTimer('run-recovery')
  assert.deepEqual(timer.calls.slice(2), ['resume:due-timer:run-recovery', 'resume:due-timer:run-recovery'])
})

test('a timer run on this deployment is woken, never cancelled', async () => {
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new'
  const timer = world({ runId: 'run-current', deploymentId: 'dpl_new' })
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
})

test('outside Vercel no holder is looked up', async () => {
  delete process.env.VERCEL_DEPLOYMENT_ID
  const timer = world({ runId: 'run-old', deploymentId: 'dpl_old' })
  dueTimerTransport.holder = async () => { throw new Error('must not be called') }
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
})

test('a failed replacement never fails the arm: the running timer is still woken', async () => {
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new'
  const timer = world({ runId: 'run-old', deploymentId: 'dpl_old' })
  const cancel = dueTimerTransport.cancel!
  dueTimerTransport.cancel = async () => { throw new Error('private transport text') }
  const logged: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }
  try { await armDueTimer('schedules') } finally { console.error = original }
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
  assert.equal(JSON.stringify(logged).includes('private'), false)
  dueTimerTransport.cancel = cancel
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules', 'cancel:run-old', 'start:schedules'])
  assert.equal(timer.live()?.deploymentId, 'dpl_new')
})

test('an older caller leaves the latest holder in place and wakes it', async () => {
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_old'
  const timer = world({ runId: 'run-new', deploymentId: 'dpl_new' })
  dueTimerTransport.latestDeployment = async () => 'dpl_new'
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
  assert.equal(timer.live()?.runId, 'run-new')
})

test('production run recovery is left to its own owner handover (#1403): never cancelled here', async () => {
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_new'
  process.env.VERCEL_ENV = 'production'
  const timer = world({ runId: 'run-old', deploymentId: 'dpl_old' })
  const looked: string[] = []
  const holder = dueTimerTransport.holder!
  dueTimerTransport.holder = async token => { looked.push(token); return token === 'due-timer:run-recovery' ? holder(token) : null }
  const { replaceStaleDueTimers } = await import('./due-timer')
  await replaceStaleDueTimers()
  assert.equal(looked.includes('due-timer:run-recovery'), false, 'run recovery is not even looked up')
  assert.deepEqual(timer.calls, [])
  assert.equal(timer.live()?.runId, 'run-old')
})
