import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { CASES, fixtureTask } from './run-observability.mjs'
import { browserReadyComment, runObservabilityWorkflow } from './run-observability-workflow.mjs'

const now = Date.parse('2026-11-06T12:00:00.000Z'), revision = 'a'.repeat(40)
const token = 'PRIVATE_GITHUB_PROGRESS_TOKEN', args = ['--execute', '--prepare', '--browser-submit']
const env = { MIKKA_ACCEPTANCE_PROGRESS_TOKEN: token, MIKKA_EXPECTED_DEPLOYMENT_SHA: revision, MIKKA_OBSERVABILITY_MODEL_CASE: 'claude',
  ACME_DEMO_EMAIL: 'PRIVATE_EMAIL', ACME_DEMO_PASSWORD: 'PRIVATE_PASSWORD', PATH: '/usr/bin',
  GITHUB_TOKEN: token, GH_TOKEN: 'PRIVATE_OTHER_TOKEN', ACCIDENTAL_ALIAS: 'Bearer ' + token }
const runnerArgs = [...args, '--runner-browser']
const runnerEnv = { ...env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: revision }
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }
function ready(item = CASES[0]) {
  const fixture = fixtureTask(revision, item)
  return { type: 'mikka_observability_browser_ready', version: 1, revision, case: item.id,
    workspaceId: '10000000-0000-4000-8000-000000000001', botId: '10000000-0000-4000-8000-000000000002',
    profileId: fixture.profileId, marker: fixture.marker, model: item.model, harness: item.harness, destination: 'cloud',
    input: fixture.input, artifact: { title: fixture.title, content: fixture.content }, expiresAt: new Date(now + 480_000).toISOString() }
}
function harness(options = {}) {
  const child = new EventEmitter(), signals = new EventEmitter(), calls = [], output = [], kills = []
  const stopped = deferred(), posted = deferred()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = signal => { kills.push(signal); stopped.resolve(); return true }
  let launch, settled = false
  const result = runObservabilityWorkflow({ args: options.args ?? args, env: options.env ?? env, now: () => now, signals,
    spawnImpl: (command, argv, settings) => { launch = { command, argv, settings }; return child },
    startBrowserImpl: options.startBrowser ?? (() => { throw new Error('PRIVATE_UNEXPECTED_BROWSER_START') }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return options.respond ? options.respond(url, init) : Response.json({ body: 'PRIVATE_GITHUB_RESPONSE', id: 123 }, { status: 201 })
    },
    writeOutput: value => { output.push(value); if (value.startsWith('Browser acceptance readiness posted')) posted.resolve() },
  }).finally(() => { settled = true })
  return { child, signals, calls, output, kills, result, stopped: stopped.promise, posted: posted.promise,
    get launch() { return launch }, get settled() { return settled },
    line: value => child.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n'),
    finish(code = 0, signal = null) { child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('close', code, signal)) },
  }
}

test('fixed progress bridge posts verified fixture once and keeps every token alias out of the driver', async () => {
  const data = harness(), value = ready(), serialized = JSON.stringify(value)
  assert.equal(data.launch.command, process.execPath)
  assert.match(data.launch.argv[0], /\/scripts\/acceptance\/run-observability\.mjs$/)
  assert.deepEqual(data.launch.argv.slice(1), args)
  assert.equal(data.launch.settings.shell, false); assert.deepEqual(data.launch.settings.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(data.launch.settings.env.ACME_DEMO_PASSWORD, env.ACME_DEMO_PASSWORD)
  assert.equal(data.launch.settings.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN, undefined)
  assert.equal(data.launch.settings.env.GITHUB_TOKEN, undefined); assert.equal(data.launch.settings.env.GH_TOKEN, undefined)
  assert.equal(data.launch.settings.env.ACCIDENTAL_ALIAS, undefined)
  assert.doesNotMatch(JSON.stringify(data.launch), /PRIVATE_GITHUB_PROGRESS_TOKEN|PRIVATE_OTHER_TOKEN/)
  // Stream chunks may cut through a UTF-8 character in the generated input.
  const bytes = Buffer.from(serialized + '\n'), split = bytes.indexOf(Buffer.from('请')) + 1
  data.child.stdout.write(bytes.subarray(0, split)); data.child.stdout.write(bytes.subarray(split))
  await data.posted
  assert.equal(data.calls.length, 1)
  const { url, init } = data.calls[0]
  assert.equal(url, 'https://api.github.com/repos/alexj11324/Mikka/issues/1512/comments')
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
  assert.equal(init.headers.authorization, 'Bearer ' + token); assert.ok(init.signal instanceof AbortSignal)
  const body = JSON.parse(init.body)
  assert.deepEqual(Object.keys(body), ['body'])
  assert.ok(body.body.includes(fixtureTask(revision, CASES[0]).input))
  assert.ok(body.body.includes(value.expiresAt)); assert.ok(body.body.includes(value.profileId))
  assert.doesNotMatch(body.body, /PRIVATE_|PRIVATE_GITHUB_RESPONSE/)
  data.line('Result: runtime_verified'); data.child.stderr.write('PRIVATE_RUNTIME_ERROR ' + token)
  data.finish(7)
  assert.equal(await data.result, 7)
  assert.ok(data.output.join('').includes('Result: runtime_verified'))
  assert.doesNotMatch(data.output.join(''), /PRIVATE_|"input"/)
  assert.equal(data.kills.length, 0)
  assert.equal(data.signals.listenerCount('SIGTERM'), 0)
})

test('flags, single-case binding and missing token reject before any child or network request', async () => {
  for (const patch of [{ args: ['--repo=foreign'] }, { args: ['--execute', '--execute'] }, { args: ['--prepare'] },
    { args: ['--browser-submit'] }, { env: { ...env, MIKKA_OBSERVABILITY_MODEL_CASE: 'all' } },
    { env: { ...env, MIKKA_ACCEPTANCE_PROGRESS_TOKEN: '' } }]) {
    let spawned = false, fetched = false
    await assert.rejects(runObservabilityWorkflow({ args, env, ...patch,
      spawnImpl: () => { spawned = true }, fetchImpl: () => { fetched = true } }), /configuration_required/)
    assert.equal(spawned, false); assert.equal(fetched, false)
  }
})

test('modified or expanded readiness never becomes an external comment or console content', async () => {
  const changed = [
    value => ({ ...value, input: value.input + ' PRIVATE_ACCOUNT_MESSAGE' }),
    value => ({ ...value, repository: 'foreign/repo', body: 'PRIVATE_ACCOUNT_MESSAGE' }),
    value => ({ ...value, profileId: value.workspaceId }),
    value => ({ ...value, revision: 'b'.repeat(40) }),
    value => ({ ...value, model: 'PRIVATE_MODEL_NAME' }),
    value => ({ ...value, artifact: { ...value.artifact, content: 'PRIVATE_ACCOUNT_FILE' } }),
    value => ({ ...value, workspaceId: 'PRIVATE_ACCOUNT_TEXT' }),
    value => ({ ...value, expiresAt: new Date(now - 1).toISOString() }),
    value => ({ ...value, expiresAt: new Date(now + 600_001).toISOString() }),
  ]
  for (const change of changed) {
    const data = harness(); data.line(change(ready())); await data.stopped
    assert.equal(data.settled, false); assert.deepEqual(data.kills, ['SIGTERM']); assert.equal(data.calls.length, 0)
    data.line('Result: blocked'); data.finish(1)
    assert.equal(await data.result, 1)
    assert.doesNotMatch(data.output.join(''), /PRIVATE_|foreign\/repo/)
  }
  for (const item of CASES) assert.ok(browserReadyComment(ready(item), { revision, item, timeoutMs: 480_000, now }).includes(item.model))
})

test('one failed or uncertain POST sends SIGTERM, waits for cleanup and is never retried', async () => {
  for (const respond of [
    async () => Response.json({ error: 'PRIVATE_ERROR_BODY' }, { status: 503 }),
    async () => Response.json({ error: 'PRIVATE_REDIRECT_BODY' }, { status: 302, headers: { location: 'https://foreign.test' } }),
    async () => { throw new Error('PRIVATE_AUTHORIZATION ' + token) },
  ]) {
    const data = harness({ respond }); data.line(ready()); await data.stopped
    assert.equal(data.calls.length, 1); assert.equal(data.settled, false)
    assert.deepEqual(data.kills, ['SIGTERM'])
    data.line(ready()) // A queued duplicate after uncertainty cannot resend.
    data.line('Result: blocked'); data.finish(0)
    assert.equal(await data.result, 1); assert.equal(data.calls.length, 1)
    assert.ok(data.output.join('').includes('progress_failed'))
    assert.doesNotMatch(data.output.join(''), /PRIVATE_|foreign\.test/)
  }
})

test('duplicate readiness cannot post twice and preserves a nonzero driver exit', async () => {
  const data = harness(); data.line(ready()); await data.posted
  data.line(ready()); await data.stopped
  data.finish(23)
  assert.equal(await data.result, 23); assert.equal(data.calls.length, 1)
  assert.ok(data.output.join('').includes('progress_duplicate'))
})

test('ordinary preflight passes safe stdout through without GitHub access and forwards termination for cleanup', async () => {
  const ordinary = harness({ args: [], env: { ...env, MIKKA_ACCEPTANCE_PROGRESS_TOKEN: undefined } })
  ordinary.line('Result: ready'); ordinary.finish(0)
  assert.equal(await ordinary.result, 0); assert.equal(ordinary.calls.length, 0)
  assert.equal(ordinary.output.join(''), 'Result: ready\n')
  const cancelled = harness()
  cancelled.signals.emit('SIGTERM'); await cancelled.stopped
  assert.equal(cancelled.settled, false)
  cancelled.line('Result: blocked'); cancelled.finish(1)
  assert.equal(await cancelled.result, 1); assert.equal(cancelled.calls.length, 0)
  assert.deepEqual(cancelled.kills, ['SIGTERM'])
})


test('runner mode rejects non-main, mismatched revision and incomplete mode flags before starting anything', async () => {
  for (const patch of [
    { args: ['--runner-browser'] }, { args: ['--execute', '--runner-browser'] },
    { args: ['--browser-submit', '--runner-browser'] },
    { env: { ...runnerEnv, GITHUB_ACTIONS: undefined } },
    { env: { ...runnerEnv, GITHUB_ACTIONS: 'false' } },
    { env: { ...runnerEnv, GITHUB_EVENT_NAME: undefined } },
    { env: { ...runnerEnv, GITHUB_EVENT_NAME: 'push' } },
    { env: { ...runnerEnv, GITHUB_REPOSITORY: 'foreign/repo' } },
    { env: { ...runnerEnv, GITHUB_REF: 'refs/heads/ops/1512-git-transport' } },
    { env: { ...runnerEnv, GITHUB_SHA: 'b'.repeat(40) } },
    { env: { ...runnerEnv, GITHUB_SHA: undefined } },
    { env: { ...runnerEnv, MIKKA_OBSERVABILITY_MODEL_CASE: 'all' } },
  ]) {
    let spawned = false, fetched = false, acted = false
    await assert.rejects(runObservabilityWorkflow({ args: runnerArgs, env: runnerEnv, ...patch,
      spawnImpl: () => { spawned = true }, fetchImpl: () => { fetched = true },
      startBrowserImpl: () => { acted = true } }), /configuration_required/)
    assert.deepEqual({ spawned, fetched, acted }, { spawned: false, fetched: false, acted: false })
  }
})

test('runner gets only validated readiness and token-free child env, with its flag removed from the driver', async () => {
  const started = deferred(), closed = deferred(), releaseClose = deferred()
  let received, starts = 0, closes = 0
  const data = harness({ args: runnerArgs, env: runnerEnv, startBrowser: async options => {
    starts++; received = options; started.resolve()
    return { close: async () => { closes++; closed.resolve(); await releaseClose.promise } }
  } })
  data.line(ready())
  await Promise.race([started.promise, data.result.then(() => { throw new Error('RUNNER_FINISHED_BEFORE_START') })])
  assert.deepEqual(data.launch.argv.slice(1), args)
  assert.equal(starts, 1); assert.deepEqual(received.ready, ready())
  assert.ok(received.signal instanceof AbortSignal)
  assert.equal(received.env, data.launch.settings.env)
  assert.equal(received.env.ACME_DEMO_PASSWORD, env.ACME_DEMO_PASSWORD)
  assert.equal(received.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN, undefined)
  assert.equal(received.env.GITHUB_TOKEN, undefined); assert.equal(received.env.GH_TOKEN, undefined)
  assert.equal(received.env.ACCIDENTAL_ALIAS, undefined)
  const body = JSON.parse(data.calls[0].init.body).body
  assert.match(body, /Runner.*自动点击一次 Create task/)
  assert.match(body, /请勿人工提交/)
  assert.doesNotMatch(body, /执行器正在等待一次真实浏览器提交|在已有登录的浏览器中|原样粘贴/)
  data.line('Result: runtime_verified'); data.finish(0)
  await closed.promise
  assert.equal(data.settled, false); assert.equal(received.signal.aborted, true)
  releaseClose.resolve()
  assert.equal(await data.result, 0); assert.equal(closes, 1)
  assert.doesNotMatch(data.output.join(''), /PRIVATE_|\{.*"input"/)
})

test('runner continues consuming readiness while the actor starts and aborts a duplicate without a second actor', async () => {
  const started = deferred(), aborted = deferred()
  let starts = 0, closes = 0
  const data = harness({ args: runnerArgs, env: runnerEnv, startBrowser: async ({ signal }) => {
    starts++; started.resolve()
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
    return { close: async () => { closes++ } }
  } })
  data.line(ready()); await started.promise
  data.line(ready()); await aborted.promise; await data.stopped
  assert.equal(starts, 1); assert.equal(data.calls.length, 1)
  assert.equal(data.settled, false); assert.deepEqual(data.kills, ['SIGTERM'])
  data.finish(0)
  assert.equal(await data.result, 1); assert.equal(closes, 1)
  assert.match(data.output.join(''), /progress_duplicate/)
})

test('runner startup failure stops the driver, waits for its cleanup and exports no error text', async () => {
  let starts = 0
  const data = harness({ args: runnerArgs, env: runnerEnv, startBrowser: async () => {
    starts++
    throw new Error('PRIVATE_BROWSER_PAGE_URL_AND_PASSWORD ' + token)
  } })
  data.line(ready()); await data.stopped
  assert.equal(data.settled, false); assert.equal(starts, 1)
  data.finish(0)
  assert.equal(await data.result, 1)
  assert.match(data.output.join(''), /browser_start_failed/)
  assert.doesNotMatch(data.output.join(''), /PRIVATE_/)
})

test('runner cleanup failure cannot be hidden by a successful driver return or replace a nonzero exit', async () => {
  for (const driverCode of [0, 7]) {
    const started = deferred()
    let closes = 0
    const data = harness({ args: runnerArgs, env: runnerEnv, startBrowser: async () => {
      started.resolve()
      return { close: async () => { closes++; throw new Error('PRIVATE_SIGN_OUT_RESPONSE') } }
    } })
    data.line(ready()); await started.promise; data.finish(driverCode)
    assert.equal(await data.result, driverCode || 1); assert.equal(closes, 1)
    assert.match(data.output.join(''), /browser_cleanup_failed/)
    assert.doesNotMatch(data.output.join(''), /PRIVATE_/)
  }
})

test('driver exit aborts pending actor startup and still awaits the late owned browser close', async () => {
  const started = deferred(), aborted = deferred(), release = deferred()
  let closes = 0
  const data = harness({ args: runnerArgs, env: runnerEnv, startBrowser: async ({ signal }) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    started.resolve(); await release.promise
    return { close: async () => { closes++ } }
  } })
  data.line(ready()); await started.promise; data.finish(9); await aborted.promise
  assert.equal(data.settled, false)
  release.resolve()
  assert.equal(await data.result, 9); assert.equal(closes, 1)
})

test('runner never starts after invalid readiness or a failed progress POST and cannot pass with missing readiness', async () => {
  for (const variant of ['invalid', 'progress', 'missing']) {
    let starts = 0
    const data = harness({ args: runnerArgs, env: runnerEnv,
      respond: variant === 'progress' ? async () => new Response(null, { status: 503 }) : undefined,
      startBrowser: async () => { starts++; return { close: async () => {} } },
    })
    if (variant === 'missing') data.finish(0)
    else {
      data.line(variant === 'invalid' ? { ...ready(), input: 'PRIVATE_ACCOUNT_TEXT' } : ready())
      await data.stopped; data.finish(0)
    }
    assert.equal(await data.result, 1); assert.equal(starts, 0)
    assert.doesNotMatch(data.output.join(''), /PRIVATE_/)
  }
})
