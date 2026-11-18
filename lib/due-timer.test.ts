import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { armDueTimer, dueTimerTransport, forgetCheckedDueTimers, type DueTimerHolder } from './due-timer'
import { productionRecoveryTimer } from './due-timer-owner'
import { wakeTransport } from './workflow-wake'

const deployment = process.env.MIKKA_DEPLOYMENT_ID, deploymentEnv = process.env.MIKKA_DEPLOYMENT_STAGE, environment = process.env.MIKKA_DEPLOYMENT_ENVIRONMENT
afterEach(() => {
  delete wakeTransport.resume; delete dueTimerTransport.start; delete dueTimerTransport.holder; delete dueTimerTransport.cancel
  delete dueTimerTransport.latestDeployment
  forgetCheckedDueTimers()
  if (deployment === undefined) delete process.env.MIKKA_DEPLOYMENT_ID; else process.env.MIKKA_DEPLOYMENT_ID = deployment
  if (deploymentEnv === undefined) delete process.env.MIKKA_DEPLOYMENT_STAGE; else process.env.MIKKA_DEPLOYMENT_STAGE = deploymentEnv
  if (environment === undefined) delete process.env.MIKKA_DEPLOYMENT_ENVIRONMENT; else process.env.MIKKA_DEPLOYMENT_ENVIRONMENT = environment
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
  dueTimerTransport.latestDeployment = async () => process.env.MIKKA_DEPLOYMENT_ID
  dueTimerTransport.cancel = async runId => { calls.push(`cancel:${runId}`); if (live?.runId === runId) live = null }
  dueTimerTransport.start = async kind => {
    calls.push(`start:${kind}`)
    if (!live) live = { runId: `run-${calls.length}`, deploymentId: process.env.MIKKA_DEPLOYMENT_ID! }
  }
  wakeTransport.resume = async token => { if (!live) throw new Error('hook not found'); calls.push(`resume:${token}`) }
  return { calls, live: () => live }
}

test('a timer run pinned to an older deployment is cancelled and replaced by one here (#1410)', async () => {
  process.env.MIKKA_DEPLOYMENT_ID = 'new_release'
  const timer = world({ runId: 'run-old', deploymentId: 'old_release' })
  await armDueTimer('run-recovery')
  assert.deepEqual(timer.calls, ['cancel:run-old', 'start:run-recovery'])
  assert.equal(timer.live()?.deploymentId, 'new_release', 'exactly one live run, on this deployment')
  // Later arms in this process only wake it: no second cancel, no second start.
  await armDueTimer('run-recovery')
  await armDueTimer('run-recovery')
  assert.deepEqual(timer.calls.slice(2), ['resume:due-timer:run-recovery', 'resume:due-timer:run-recovery'])
})

test('a timer run on this deployment is woken, never cancelled', async () => {
  process.env.MIKKA_DEPLOYMENT_ID = 'new_release'
  const timer = world({ runId: 'run-current', deploymentId: 'new_release' })
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
})

test('without a deployment identity no stale holder is looked up', async () => {
  delete process.env.MIKKA_DEPLOYMENT_ID
  const timer = world({ runId: 'run-old', deploymentId: 'old_release' })
  dueTimerTransport.holder = async () => { throw new Error('must not be called') }
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
})

test('a failed replacement never fails the arm: the running timer is still woken', async () => {
  process.env.MIKKA_DEPLOYMENT_ID = 'new_release'
  const timer = world({ runId: 'run-old', deploymentId: 'old_release' })
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
  assert.equal(timer.live()?.deploymentId, 'new_release')
})

test('an older caller leaves the latest holder in place and wakes it', async () => {
  process.env.MIKKA_DEPLOYMENT_ID = 'old_release'
  const timer = world({ runId: 'run-new', deploymentId: 'new_release' })
  dueTimerTransport.latestDeployment = async () => 'new_release'
  await armDueTimer('schedules')
  assert.deepEqual(timer.calls, ['resume:due-timer:schedules'])
  assert.equal(timer.live()?.runId, 'run-new')
})

test('production run recovery is left to its own owner handover (#1403): never cancelled here', async () => {
  process.env.MIKKA_DEPLOYMENT_ID = 'new_release'
  process.env.MIKKA_DEPLOYMENT_STAGE = 'production'
  const timer = world({ runId: 'run-old', deploymentId: 'old_release' })
  const looked: string[] = []
  const holder = dueTimerTransport.holder!
  dueTimerTransport.holder = async token => { looked.push(token); return token === 'due-timer:run-recovery' ? holder(token) : null }
  const { replaceStaleDueTimers } = await import('./due-timer')
  await replaceStaleDueTimers()
  assert.equal(looked.includes('due-timer:run-recovery'), false, 'run recovery is not even looked up')
  assert.deepEqual(timer.calls, [])
  assert.equal(timer.live()?.runId, 'run-old')
})


test('production recovery ownership uses Mikka deployment configuration, not legacy Vercel flags', () => {
  const names = ['MIKKA_DEPLOYMENT_STAGE', 'MIKKA_DEPLOYMENT_ENVIRONMENT', 'VERCEL', 'VERCEL_ENV'] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    delete process.env.MIKKA_DEPLOYMENT_STAGE
    delete process.env.MIKKA_DEPLOYMENT_ENVIRONMENT
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'production'
    assert.equal(productionRecoveryTimer(), false)
    process.env.MIKKA_DEPLOYMENT_ENVIRONMENT = 'preview'
    assert.equal(productionRecoveryTimer(), false)
    process.env.MIKKA_DEPLOYMENT_STAGE = 'production'
    assert.equal(productionRecoveryTimer(), true)
  } finally {
    for (const name of names) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})
