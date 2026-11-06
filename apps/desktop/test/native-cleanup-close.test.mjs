import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { closeElectron } from './native-cleanup.mjs'

async function application(t, { failures = [], active = true, cancelFails = false } = {}) {
  // A real original ChildProcess supplies the exit proof; only the renderer
  // navigation/IPC response is a unit fixture. Real Electron is tested by the
  // separate file-navigation regression, not claimed by this fixture.
  const child = spawn(process.execPath, ['-e', 'process.on("message",()=>process.exit(0));process.send("ready")'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await once(child, 'message', { signal: AbortSignal.timeout(5000) })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
  const state = { evaluations: 0, navigations: 0, cancellations: 0, closes: 0, status: active ? 'running' : 'idle' }
  const ssh = {
    async state() { return { id: 'owned-fixture', status: state.status } },
    async cancel(id) { assert.equal(id, 'owned-fixture'); state.cancellations++; if (cancelFails) throw new Error('synthetic-cancel-denied'); state.status = 'cancelled' },
  }
  const page = {
    isClosed: () => false,
    evaluate(fn) {
      const failure = failures[state.evaluations++]
      if (failure) return Promise.reject(failure)
      return runInNewContext(`(${fn.toString()})()`, { window: { mikka: { ssh } } })
    },
    async waitForLoadState(value) { assert.equal(value, 'domcontentloaded'); state.navigations++ },
  }
  const app = { process: () => child, windows: () => [page], async close() { state.closes++; child.send('close'); await exited } }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.send('close'); await exited }
  })
  return { app, child, state, exited }
}

test('navigation during the installer read repeats the real cancellation contract before a clean original-child exit', async t => {
  const value = await application(t, { failures: [new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.')] })
  await closeElectron(value.app)
  assert.deepEqual(await value.exited, [0, null])
  assert.equal(value.child.exitCode, 0)
  assert.equal(value.state.navigations, 1)
  assert.equal(value.state.cancellations, 1)
  assert.equal(value.state.status, 'cancelled')
  assert.equal(value.state.closes, 1)
})

test('concurrent and later close calls share one operation, including after actual process exit', async t => {
  const value = await application(t)
  const first = closeElectron(value.app)
  assert.equal(closeElectron(value.app), first)
  await first
  await closeElectron(value.app)
  assert.deepEqual(await value.exited, [0, null])
  assert.equal(value.state.cancellations, 1)
  assert.equal(value.state.closes, 1)
})

test('unknown renderer failures remain failures and cannot be erased by an idempotent cleanup call', async t => {
  const failure = new Error('synthetic-private-renderer-failure')
  const value = await application(t, { failures: [failure] })
  await assert.rejects(closeElectron(value.app), error => error === failure)
  assert.deepEqual(await value.exited, [0, null])
  await assert.rejects(closeElectron(value.app), error => error === failure)
  assert.equal(value.state.navigations, 0)
  assert.equal(value.state.closes, 1)
  assert.equal(value.state.cancellations, 0)
})

test('an active installer cancellation failure still fails even when Electron subsequently exits cleanly', async t => {
  const value = await application(t, { cancelFails: true })
  await assert.rejects(closeElectron(value.app), /synthetic-cancel-denied/)
  assert.deepEqual(await value.exited, [0, null])
  assert.equal(value.state.status, 'running')
  assert.equal(value.state.navigations, 0)
  await assert.rejects(closeElectron(value.app), /synthetic-cancel-denied/)
  assert.equal(value.state.closes, 1)
})
