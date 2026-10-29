import test from 'node:test'
import assert from 'node:assert/strict'

import { NotificationCenter, type NotificationSink } from './notification-center'

function recordingSink(supported = true) {
  const shown: { title: string; body: string; onClick: () => void }[] = []
  const badges: number[] = []
  const sink: NotificationSink = {
    isSupported: () => supported,
    show: (title, body, onClick) => { shown.push({ title, body, onClick }) },
    setBadge: count => { badges.push(count) },
  }
  return { sink, shown, badges }
}

const notification = (id: string) => ({
  id,
  kind: 'failed',
  title: 'MIK-1 · 失败',
  body: '构建任务',
  href: '/issue/mik-1',
})

test('shows each notification id once', () => {
  const recorder = recordingSink()
  const delivered: string[] = []
  const center = new NotificationCenter(recorder.sink, href => delivered.push(href), () => 0)
  center.show(notification('a'))
  center.show(notification('a'))
  assert.equal(recorder.shown.length, 1)
  recorder.shown[0].onClick()
  assert.deepEqual(delivered, ['/issue/mik-1'])
})

test('caps notifications at five per minute', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 1_000)
  for (let index = 0; index < 6; index += 1) center.show(notification(String(index)))
  assert.equal(recorder.shown.length, 5)
})

test('allows a new notification after the window passes', () => {
  const recorder = recordingSink()
  let now = 1_000
  const center = new NotificationCenter(recorder.sink, () => {}, () => now)
  center.show(notification('a'))
  now += 61_000
  center.show(notification('b'))
  assert.equal(recorder.shown.length, 2)
})

test('does nothing where notifications are unsupported', () => {
  const recorder = recordingSink(false)
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  center.show(notification('a'))
  assert.equal(recorder.shown.length, 0)
})

test('refuses an invalid payload instead of showing it', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  assert.throws(() => center.show({ id: 'a', kind: 'other', title: 'x', body: 'y', href: '/z' }))
  assert.throws(() => center.show({ id: 'a', kind: 'failed', title: 'x', body: 'y', href: 'https://evil.example' }))
  assert.equal(recorder.shown.length, 0)
})

test('badge counts are bounded', () => {
  const recorder = recordingSink()
  const center = new NotificationCenter(recorder.sink, () => {}, () => 0)
  center.setBadge(3)
  assert.deepEqual(recorder.badges, [3])
  assert.throws(() => center.setBadge(-1))
  assert.throws(() => center.setBadge(10_000))
})
