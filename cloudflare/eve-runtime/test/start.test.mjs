import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startCloudflareEveHost } from '../runtime/start.mjs'

const sourceSha = 'a'.repeat(40), uiSha = 'b'.repeat(40)
const build = { version: 1, eve: '1.0.0-rc.9', revision: sourceSha, preset: 'node-server',
  world: '@mikka/eve-cloudflare-world', worldVersion: '5.1.0' }
const host = { version: 1, releaseId: 'fixture-1', sourceSha, uiSha }
const environment = {
  MIKKA_EVE_HOST: 'cloudflare', MIKKA_EVE_WORKFLOW_WORLD: 'cloudflare',
  MIKKA_BUILD_REVISION: sourceSha, MIKKA_UI_OVERLAY_SHA: uiSha, MIKKA_EVE_RELEASE_ID: 'fixture-1',
}
const load = async path => JSON.stringify(path.endsWith('eve-host.json') ? host : build)

test('the host validates the image before starting a process', async () => {
  let started = false
  await assert.rejects(startCloudflareEveHost({
    env: { ...environment, MIKKA_BUILD_REVISION: 'c'.repeat(40) }, load,
    startService: async () => { started = true },
  }), /CF_EVE_HOST_CONFIGURATION_INVALID/)
  assert.equal(started, false)
})

test('SIGTERM/SIGINT drain the same native child once and wait for its actual exit', async () => {
  let exit, ready, received, closes = 0
  const exited = new Promise(resolve => { exit = resolve })
  const observing = new Promise(resolve => { ready = resolve })
  class Signals extends EventEmitter {
    once(name, handler) { super.once(name, handler); if (name === 'SIGINT') ready(); return this }
  }
  const signals = new Signals()
  const running = startCloudflareEveHost({
    env: environment, load, signals,
    startService: async options => {
      received = options
      return { origin: 'http://127.0.0.1:8080', exited, close: async () => {
        closes++
        exit({ code: 0, signal: null })
      } }
    },
  })
  await observing
  assert.deepEqual(received.listen, { host: '0.0.0.0', port: 8080 })
  signals.emit('SIGTERM'); signals.emit('SIGINT')
  assert.deepEqual(await running, { code: 0, signal: null })
  assert.equal(closes, 1)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('an unexpected child exit fails the host instead of leaving an idle parent alive', async () => {
  await assert.rejects(startCloudflareEveHost({
    env: environment, load, signals: new EventEmitter(),
    startService: async () => ({
      origin: 'http://127.0.0.1:8080', exited: Promise.resolve({ code: 1, signal: null }), close: async () => {},
    }),
  }), /CF_EVE_SERVICE_EXITED/)
})

test('a skipped or malformed child is closed and cannot be reported ready', async () => {
  let closed = false
  await assert.rejects(startCloudflareEveHost({
    env: environment, load, signals: new EventEmitter(),
    startService: async () => ({ close: async () => { closed = true } }),
  }), /CF_EVE_SERVICE_REQUIRED/)
  assert.equal(closed, true)
})
