import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startLiveWorker } from './live-worker.mjs'

const settings = { root: process.cwd(), name: 'desktop-acceptance-gateway', secret: 'a'.repeat(64) }
function processFixture({ origin = 'http://127.0.0.1:34567', onDispose, ready = true } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, connected: true,
    stderr: { resume() {} }, messages: [] })
  const finish = (code = 0) => { child.exitCode = code; child.connected = false; child.emit('exit', code, null) }
  child.send = (message, callback) => {
    child.messages.push(message)
    queueMicrotask(() => {
      callback?.(null)
      if (message.type === 'start' && ready) child.emit('message', { type: 'ready', origin })
      if (message.type === 'dispose') {
        if (onDispose) onDispose(child, finish)
        else { child.emit('message', { type: 'disposed' }); finish() }
      }
    })
  }
  return { child, finish, forkImpl: (file, args, options) => {
    assert.ok(file.endsWith('/live-worker.mjs')); assert.deepEqual(args, ['--worker-child'])
    assert.equal(options.detached, process.platform !== 'win32')
    assert.deepEqual(options.execArgv, [])
    for (const name of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'NODE_OPTIONS', 'MIKKA_TEST_ENVIRONMENT_FILE']) assert.equal(Object.hasOwn(options.env, name), false)
    assert.equal(JSON.stringify(options).includes(settings.secret), false, 'The Worker key travels only over owned IPC')
    return child
  } }
}

test('the Worker has its own process, private initialization and an actual disposal-and-exit barrier', async () => {
  let finish
  const fixture = processFixture({ onDispose: (child, ended) => { child.emit('message', { type: 'disposed' }); finish = ended } })
  const owner = await startLiveWorker({ ...settings, forkImpl: fixture.forkImpl })
  assert.equal(owner.origin, 'http://127.0.0.1:34567')
  assert.equal(fixture.child.messages[0].secret, settings.secret)
  let completed = false
  const result = owner.close().then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false, 'An IPC disposal acknowledgement is not process exit')
  finish(); await result
  await owner.close()
  assert.deepEqual(fixture.child.messages.map(message => message.type), ['start', 'dispose'])
})

test('an invalid or foreign ready URL is refused and the newly owned Worker is still disposed', async () => {
  for (const origin of ['https://other.example', 'http://localhost:34567', 'http://127.0.0.1:34567/private', 'http://private@127.0.0.1:34567']) {
    const fixture = processFixture({ origin })
    await assert.rejects(startLiveWorker({ ...settings, forkImpl: fixture.forkImpl }), /LIVE_WORKER_START_FAILED/)
    assert.deepEqual(fixture.child.messages.map(message => message.type), ['start', 'dispose'])
    assert.equal(fixture.child.exitCode, 0)
  }
})

test('startup timeout and owner cancellation both dispose the owned child before returning failure', async () => {
  for (const abort of [false, true]) {
    const fixture = processFixture({ ready: false })
    const controller = new AbortController()
    if (abort) controller.abort()
    await assert.rejects(startLiveWorker({ ...settings, forkImpl: fixture.forkImpl, signal: controller.signal, startMs: 5 }),
      abort ? /LIVE_WORKER_START_ABORTED/ : /LIVE_WORKER_START_TIMEOUT/)
    assert.equal(fixture.child.exitCode, 0)
    assert.equal(fixture.child.messages.at(-1).type, 'dispose')
  }
})

test('an exit without successful disposal and a later failed exit cannot become clean evidence', async () => {
  for (const code of [0, 1]) {
    const fixture = processFixture({ onDispose: (child, finish) => {
      if (code) child.emit('message', { type: 'disposed' })
      finish(code)
    } })
    const owner = await startLiveWorker({ ...settings, forkImpl: fixture.forkImpl })
    await assert.rejects(owner.close(), code ? /LIVE_WORKER_EXIT_FAILED/ : /LIVE_WORKER_DISPOSAL_UNPROVEN/)
  }
})
