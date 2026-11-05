import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { armDueTimer, dueTimerTransport } from './due-timer'
import { wakeTransport } from './workflow-wake'

afterEach(() => { delete wakeTransport.resume; delete dueTimerTransport.start })

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
