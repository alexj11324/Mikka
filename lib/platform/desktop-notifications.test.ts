import test from 'node:test'
import assert from 'node:assert/strict'

import { desktopRunUpdate, type DesktopRun } from './desktop-notifications'

function run(overrides: Partial<DesktopRun> = {}): DesktopRun {
  return {
    issueId: 'issue-1',
    issueTitle: 'Ship the desktop app',
    agentName: 'Coordinator',
    status: 'running',
    ...overrides,
  }
}

test('the launch snapshot seeds the badge without replaying notifications', () => {
  const update = desktopRunUpdate(null, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
    run({ issueId: 'c', status: 'running' }),
  ])
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [])
  assert.deepEqual(update.next, new Map([['a', 'waiting_input'], ['b', 'failed'], ['c', 'running']]))
})

test('entering 等你 and failing raise one notification each', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'running'], ['b', 'running'], ['c', 'succeeded']])
  const update = desktopRunUpdate(previous, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
    run({ issueId: 'c', status: 'succeeded' }),
  ], 1_000)
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [
    { id: 'run:a:awaiting:1000', kind: 'awaiting', title: 'Ship the desktop app', body: 'Coordinator', href: '/?issue=a' },
    { id: 'run:b:failed:1000', kind: 'failed', title: 'Ship the desktop app', body: 'Coordinator', href: '/?issue=b' },
  ])
})

test('an unchanged poll stays silent', () => {
  const previous = new Map<string, DesktopRun['status']>([['a', 'waiting_input'], ['b', 'failed']])
  const update = desktopRunUpdate(previous, [
    run({ issueId: 'a', status: 'waiting_input' }),
    run({ issueId: 'b', status: 'failed' }),
  ])
  assert.equal(update.badge, 1)
  assert.deepEqual(update.notifications, [])
})

test('a run that appears after launch can notify', () => {
  const update = desktopRunUpdate(new Map(), [run({ issueId: 'new', status: 'waiting_input' })], 1_000)
  assert.deepEqual(update.notifications.map(item => item.id), ['run:new:awaiting:1000'])
})

test('runs that disappear only update the map', () => {
  const update = desktopRunUpdate(new Map<string, DesktopRun['status']>([['gone', 'waiting_input']]), [])
  assert.equal(update.badge, 0)
  assert.deepEqual(update.notifications, [])
  assert.equal(update.next.size, 0)
})
