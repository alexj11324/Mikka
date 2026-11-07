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
