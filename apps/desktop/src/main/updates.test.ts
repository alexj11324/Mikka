import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { Updates, type Updater } from './updates'

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
    available: version => reports.push(`available ${version}`),
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

test('a background check is silent and only a downloaded update is surfaced', async () => {
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

test('the menu check reports up to date, a new version and errors', async () => {
  const { updater, updates, reports } = setup()
  updater.next = u => { u.emit('update-not-available') }
  await updates.check(true)
  updater.next = u => { u.emit('update-available', { version: '0.2.0' }) }
  await updates.check(true)
  updater.next = u => { u.emit('error', new Error('offline')) }
  await updates.check(true)
  assert.deepEqual(reports, ['up to date', 'available 0.2.0', 'failed offline'])

  updater.emit('update-downloaded', { version: '0.2.0' })
  await updates.check(true)
  assert.deepEqual(reports.at(-1), 'available 0.2.0')
})

test('install restarts only once an update is downloaded', () => {
  const { updater, updates } = setup()
  updates.install()
  assert.equal(updater.installs, 0)
  updater.emit('update-downloaded', { version: '0.2.0' })
  updates.install()
  assert.equal(updater.installs, 1)
})
