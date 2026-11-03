import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { Updates, updateCopy, type Updater } from './updates'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installs = 0
  next: (updater: FakeUpdater) => void = () => {}
  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    this.next(this)
    return Promise.resolve(null)
  }
  quitAndInstall(): void { this.installs += 1 }
}

function setup() {
  const updater = new FakeUpdater()
  const reports: string[] = []
  const ready: string[] = []
  const updates = new Updates(updater as unknown as Updater, {
    ready: version => reports.push(`ready ${version}`),
    upToDate: () => reports.push('up to date'),
    failed: error => reports.push(`failed ${error.message}`),
  }, version => ready.push(version))
  return { updater, updates, reports, ready }
}

test('downloads in the background and installs on quit', () => {
  const { updater } = setup()
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
})

test('a background check opens no dialog; only a downloaded update reaches the rail', async () => {
  const { updater, updates, reports, ready } = setup()
  updater.next = u => { u.emit('update-available', { version: '0.2.0' }) }
  await updates.check(false)
  assert.equal(updates.ready, null)
  assert.deepEqual(ready, [])

  updater.emit('error', new Error('network'))
  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(updates.ready, '0.2.0')
  assert.deepEqual(ready, ['0.2.0'])
  assert.deepEqual(reports, [])

  // Once downloaded, periodic checks stop.
  await updates.check(false)
  assert.equal(updater.checks, 1)
})

test('a menu check that finds a new version says nothing until it has downloaded, then offers the restart', async () => {
  const { updater, updates, reports } = setup()
  updater.next = u => { u.emit('update-available', { version: '0.2.0' }) }
  await updates.check(true)
  assert.deepEqual(reports, [])
  updater.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(reports, ['ready 0.2.0'])

  // Asked again once it is downloaded: the same offer, at once.
  await updates.check(true)
  assert.deepEqual(reports, ['ready 0.2.0', 'ready 0.2.0'])
})

test('a menu check reports up to date and errors, including a failed download it started', async () => {
  const { updater, updates, reports } = setup()
  updater.next = u => { u.emit('update-not-available') }
  await updates.check(true)
  updater.next = u => { u.emit('error', new Error('offline')) }
  await updates.check(true)
  updater.next = u => { u.emit('update-available', { version: '0.2.0' }) }
  await updates.check(true)
  updater.emit('error', new Error('download'))
  assert.deepEqual(reports, ['up to date', 'failed offline', 'failed download'])
})

test('install restarts only once an update is downloaded', () => {
  const { updater, updates } = setup()
  updates.install()
  assert.equal(updater.installs, 0)
  updater.emit('update-downloaded', { version: '0.2.0' })
  updates.install()
  assert.equal(updater.installs, 1)
})

test('the menu check speaks Chinese unless the system language is not', () => {
  assert.equal(updateCopy('zh-CN').restart('2026.10000.290'), '重启以更新到 v2026.10000.290')
  assert.equal(updateCopy('zh-Hans-CN').restartNow, '立即重启')
  assert.equal(updateCopy('en-US').later, 'Later')
})
