import test from 'node:test'
import assert from 'node:assert/strict'
import { readNativeStartup } from '../test/native-startup.mjs'

test('native startup evidence keeps exact numeric phases and drops URLs, arbitrary marks and resource metadata', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  t.after(() => Object.defineProperty(globalThis, 'performance', descriptor))
  const marks = {
    'mikka.startup.main.ready': 8,
    'mikka.startup.main.restore.start': 10, 'mikka.startup.main.restore.end': 120,
    'mikka.startup.main.window.start': 12, 'mikka.startup.main.window.created': 30,
    'mikka.startup.renderer.entry': 40,
    'mikka.startup.renderer.bootstrap.start': 45, 'mikka.startup.renderer.bootstrap.end': 150,
    'mikka.startup.renderer.workspace.import.start': 50, 'mikka.startup.renderer.workspace.import.end': 100,
    'mikka.startup.renderer.workspace.mounted': 160,
    'private-session-token': 1,
  }
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    getEntriesByName: name => name in marks ? [{ startTime: marks[name], detail: 'private-email' }] : [],
    getEntriesByType: type => type === 'navigation'
      ? [{ responseStart: 2, responseEnd: 5, domInteractive: 40, domContentLoadedEventEnd: 43, loadEventEnd: 44, name: 'https://server.invalid/mikka?private-token' }]
      : [
        { name: 'mikka://app/mikka/api/desktop/rpc?private-token', startTime: 45, duration: 105, responseEnd: 150, serverTiming: [{ description: 'private-cookie' }] },
        { name: 'mikka://app/mikka/assets/private-user.js', startTime: 50, duration: 40, responseEnd: 90 },
        { name: 'mikka://app/mikka/assets/private-token.js', startTime: 90, duration: 10, responseEnd: 100 },
      ],
  } })
  const result = await readNativeStartup({ evaluate: (fn, names) => fn({}, names) }, { evaluate: (fn, names) => fn(names) })
  assert.deepEqual(result.phasesMs, { restore: 110, windowCreation: 18, bootstrap: 105, workspaceImport: 50 })
  assert.deepEqual(result.renderer.completedResources.script, { count: 2, totalDurationMs: 50, firstStartMs: 50, lastEndMs: 100 })
  assert.equal(result.main['window.created'] < result.main['restore.end'], true, 'evidence shows the actual overlap without changing the measured elapsed time')
  assert.equal(JSON.stringify(result).includes('private-'), false)
})

test('absent marks in the unchanged hosted renderer are explicit null, never a fabricated zero duration', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  t.after(() => Object.defineProperty(globalThis, 'performance', descriptor))
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    getEntriesByName: () => [], getEntriesByType: () => [],
  } })
  const result = await readNativeStartup({ evaluate: (fn, names) => fn({}, names) }, { evaluate: (fn, names) => fn(names) })
  assert.deepEqual(result.phasesMs, { restore: null, windowCreation: null, bootstrap: null, workspaceImport: null })
  assert.deepEqual(result.renderer.completedResources, {})
})
