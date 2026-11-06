import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { nativeLifecycleFailure, observeNativeNavigation } from './native-document.mjs'

test('navigation evidence records bounded main-document transitions without URLs or query values', () => {
  const page = new EventEmitter()
  const main = {}, child = {}
  let url = 'about:blank', at = 100
  page.url = () => url
  page.mainFrame = () => main
  const record = { events: [], overflow: false }
  observeNativeNavigation(page, record, { now: () => at, limit: 3 })
  page.emit('framenavigated', child)
  assert.equal(record.events.length, 0)
  page.emit('domcontentloaded')
  at = 110; url = 'mikka://app/mikka?state=private-state'
  page.emit('framenavigated', main)
  page.emit('domcontentloaded')
  url = 'https://private-user.example/path?token=private-token'
  page.emit('framenavigated', main)
  assert.deepEqual(record, { overflow: true, events: [
    { event: 'domcontentloaded', document: 0, route: 'blank', elapsedMs: 0 },
    { event: 'committed', document: 1, route: 'bundled-root', elapsedMs: 10 },
    { event: 'domcontentloaded', document: 1, route: 'bundled-root', elapsedMs: 10 },
  ] })
  assert.equal(JSON.stringify(record).includes('private'), false)
})

test('failure evidence retains a closed error class and owned source locations only', () => {
  const failure = new Error('page.evaluate: Execution context was destroyed; https://private.example/?token=secret')
  failure.stack = 'Error: secret\n at /private/owner/apps/desktop/test/lifecycle.mjs:148:11\n at /private/secret.ts:3:2\n at /private/apps/desktop/test/bundled-session.mjs:16:9'
  const result = nativeLifecycleFailure(failure)
  assert.deepEqual(result, { kind: 'Error', code: 'navigation-context-destroyed', locations: [
    { file: 'lifecycle.mjs', line: 148, column: 11 }, { file: 'bundled-session.mjs', line: 16, column: 9 },
  ] })
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(nativeLifecycleFailure({ name: 'private-token', message: 'private-user' }), { kind: 'other', code: 'other', locations: [] })
})
