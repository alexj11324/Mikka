import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { createAcceptanceCheck } from './acceptance-check.mjs'

function fixture(step = async (_name, _timeout, action) => action()) {
  let interrupted = false
  const completedItems = [], failures = []
  return {
    completedItems, failures,
    interrupt: () => { interrupted = true },
    check: createAcceptanceCheck({ step, isInterrupted: () => interrupted, completedItems, failures }),
  }
}

test('an already interrupted acceptance cannot start another item', async () => {
  const started = []
  const runner = fixture(async name => { started.push(name) })
  runner.interrupt()
  await assert.rejects(runner.check('item2-read-only', 600_000), /Acceptance interrupted/)
  assert.deepEqual(started, [])
  assert.deepEqual(runner.completedItems, [])
  assert.deepEqual(runner.failures, [])
})

test('interruption during a failed item escapes instead of advancing the sequence', async () => {
  const stopped = new Error('The interrupted item stopped')
  const started = []
  const runner = fixture()
  await assert.rejects(async () => {
    await runner.check('item1-core-loop', 600_000, async () => {
      started.push(1)
      runner.interrupt()
      throw stopped
    })
    await runner.check('item2-read-only', 600_000, async () => { started.push(2) })
  }, error => error === stopped)
  assert.deepEqual(started, [1])
  assert.deepEqual(runner.completedItems, [])
  assert.deepEqual(runner.failures, [])
})

test('an item completing after interruption cannot be marked passed or advance the sequence', async () => {
  const started = []
  const runner = fixture()
  await assert.rejects(async () => {
    await runner.check('item1-core-loop', 600_000, async () => {
      started.push(1)
      runner.interrupt()
    })
    await runner.check('item2-read-only', 600_000, async () => { started.push(2) })
  }, /Acceptance interrupted/)
  assert.deepEqual(started, [1])
  assert.deepEqual(runner.completedItems, [])
})

test('ordinary item failures still accumulate while later selected items run', async () => {
  const failure = new Error('An ordinary failed assertion')
  const runner = fixture()
  assert.equal(await runner.check('item1-core-loop', 600_000, async () => { throw failure }), undefined)
  assert.equal(await runner.check('item2-read-only', 600_000, async () => 'completed'), 'completed')
  assert.deepEqual(runner.failures, [failure])
  assert.deepEqual(runner.completedItems, [2])
})

test('real SIGTERM stops the item sequence and completes owned cleanup without another action', { timeout: 10_000, skip: process.platform === 'win32' }, async t => {
  const source = `
    import { createAcceptanceCheck } from ${JSON.stringify(new URL('./acceptance-check.mjs', import.meta.url).href)}
    let interrupted = false, releaseStep, cleanupPromise, cleanupCount = 0
    const alive = setInterval(() => {}, 1_000)
    const started = [], completedItems = [], failures = []
    const cleanup = () => cleanupPromise ??= Promise.resolve().then(() => { cleanupCount++ })
    process.once('SIGTERM', () => {
      interrupted = true
      releaseStep()
      void cleanup()
    })
    const check = createAcceptanceCheck({
      isInterrupted: () => interrupted, completedItems, failures,
      step: async (name, _timeout, action) => { started.push(name); return action() },
    })
    let error
    try {
      await check('item1-core-loop', 600_000, async () => {
        await new Promise(resolve => { releaseStep = resolve; process.send({ ready: true }) })
        if (interrupted) throw new Error('Acceptance interrupted')
      })
      await check('item2-read-only', 600_000, async () => {})
      await check('item3-failure-stage', 240_000, async () => {})
    } catch (caught) {
      error = caught.message
      process.exitCode = 1
    } finally { await cleanup(); clearInterval(alive) }
    process.send({ started, completedItems, failures: failures.length, cleanupCount, error })
    process.disconnect()
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {},
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  assert.deepEqual((await once(child, 'message'))[0], { ready: true })
  const result = once(child, 'message')
  assert.equal(child.kill('SIGTERM'), true)
  const [evidence] = await result
  const [exitCode, signal] = await exited
  assert.equal(stderr, '')
  assert.equal(exitCode, 1)
  assert.equal(signal, null)
  assert.deepEqual(evidence, {
    started: ['item1-core-loop'],
    completedItems: [],
    failures: 0,
    cleanupCount: 1,
    error: 'Acceptance interrupted',
  })
})
