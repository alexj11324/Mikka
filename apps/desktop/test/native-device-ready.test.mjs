import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import path from 'node:path'
import { nativeDeviceEnvironment, nativeDeviceIsReady, nativeDeviceSnapshot, waitForNativeDevice } from './native-device-ready.mjs'

const raw = { device: { status: 'online', deviceId: 'private-device-id', signedIn: true, server: 'online' },
  install: { id: 'private-install-id', target: 'this-computer', status: 'online', step: 'connect' } }
async function snapshot(value = raw) {
  const read = vm.runInNewContext(`(${nativeDeviceSnapshot.toString()})`, { window: { mikka: {
    device: { status: async () => value.device }, ssh: { state: async () => value.install },
  } } })
  return JSON.parse(JSON.stringify(await read()))
}

test('native readiness requires the real bridge, daemon identity, authentication and server connection', async () => {
  const value = await snapshot()
  assert.equal(nativeDeviceIsReady(value), true)
  for (const patch of [{ status: 'offline' }, { deviceId: null }, { signedIn: false }, { server: 'offline' }]) {
    assert.equal(nativeDeviceIsReady(await snapshot({ ...raw, device: { ...raw.device, ...patch } })), false)
  }
  for (const status of ['running', 'fingerprint', 'failed', 'unknown']) assert.equal(nativeDeviceIsReady(await snapshot({ ...raw, install: { ...raw.install, status } })), false)
  assert.equal(nativeDeviceIsReady(await snapshot({ ...raw, install: undefined })), false)
  assert.equal(JSON.stringify(value).includes('private-'), false)
})

test('installer failures are a closed projection, never raw npm output, identifiers, arguments or exception strings', async () => {
  for (const [reason, expected] of [
    ['npm error ENOTEMPTY rename /private/credential=secret', 'npm-directory-not-empty'],
    ['npm error EACCES /private/profile', 'permission-denied'],
    ['Bootstrap failed: 5: Input/output error /private/path', 'service-bootstrap-failed'],
    ['arbitrary secret bearer@example.test', 'other'],
  ]) {
    const value = await snapshot({ ...raw, install: { ...raw.install, status: 'failed', reason } })
    assert.equal(value.installer.reason, expected)
    for (const privateText of ['secret', 'credential', '/private', 'bearer@example.test', 'private-install-id', 'private-device-id']) assert.equal(JSON.stringify(value).includes(privateText), false)
  }
})

test('rejected or unavailable IPC reads fail readiness without exporting the cause', async () => {
  const read = vm.runInNewContext(`(${nativeDeviceSnapshot.toString()})`, { window: { mikka: {
    device: { status: async () => { throw new Error('private exception') } }, ssh: { state: async () => null },
  } } })
  const value = await read()
  assert.equal(nativeDeviceIsReady(value), false)
  assert.equal(value.device.read, 'rejected')
  assert.equal(JSON.stringify(value).includes('private'), false)
})

test('bounded waiter retries real false states, records transitions and preserves a failed gate', async () => {
  let at = 0, checks = 0, reads = 0, evidence
  const offline = await snapshot({ ...raw, device: { ...raw.device, status: 'offline' } })
  const ready = await snapshot()
  const options = { profile: '/owned/profile', scope: { assertActive: async () => { checks++ } }, timeout: 1000,
    now: () => at, delay: async milliseconds => { at += milliseconds },
    metadata: async () => ({ status: 'unavailable', reason: 'socket_or_profile_missing' }), environment: async () => ({ available: false, reason: 'profile-mismatch' }),
    record: value => { evidence = value }, snapshot: async () => ++reads > 2 ? ready : offline }
  await waitForNativeDevice({ mode: 'bundled' }, options)
  assert.equal(evidence.ready, true)
  assert.equal(checks, 3)
  assert.equal(evidence.transitions.length, 2)
  assert.equal(evidence.elapsedMs, 500)
  at = 0
  await assert.rejects(waitForNativeDevice({ mode: 'hosted' }, { ...options, snapshot: async () => offline }), { message: 'PARITY_NATIVE_DEVICE_NOT_READY' })
  assert.equal(evidence.ready, false)
  assert.equal(evidence.elapsedMs, 1000)
  assert.equal(evidence.failure, 'deadline')
  assert.equal(evidence.transitions.length, 1)
  assert.equal(evidence.environment.reason, 'profile-mismatch')
  at = 0
  const failed = await snapshot({ ...raw, install: { ...raw.install, status: 'failed', step: 'install', reason: 'npm error ENOTEMPTY /private/path' } })
  await assert.rejects(waitForNativeDevice({ mode: 'bundled' }, { ...options, snapshot: async () => failed }), { message: 'PARITY_NATIVE_DEVICE_NOT_READY' })
  assert.equal(evidence.failure, 'installer-failed')
  assert.equal(evidence.elapsedMs, 0, 'Terminal installer failures must not wait out the setup allowance')
  assert.equal(evidence.reads, 1)
})

test('metadata failures cannot replace a lease failure or turn it into readiness', async () => {
  const failure = new Error('LEASE_LOST')
  let evidence
  await assert.rejects(waitForNativeDevice({ mode: 'bundled' }, { profile: '/owned/profile', record: value => { evidence = value },
    scope: { assertActive: async () => { throw failure } },
    snapshot: async () => { throw new Error('must not read') }, metadata: async () => { throw new Error('private metadata') }, environment: async () => { throw new Error('private environment') },
  }), error => error === failure)
  assert.equal(evidence.ready, false)
  assert.equal(JSON.stringify(evidence).includes('private'), false)
})

test('main profile inspection rejects other profiles and reports only fixed service argument comparisons', async () => {
  let reads = 0
  const profile = '/owned/Mikka & Dev'
  const fake = {
    evaluate: async (callback, input) => vm.runInNewContext(`(${callback.toString()})`, {
      process: { platform: 'darwin', env: { MIKKA_USER_DATA_DIR: profile }, getBuiltinModule: name => ({
        'node:path': path, 'node:os': { homedir: () => '/owned/home' },
        'node:fs/promises': { realpath: async value => value, lstat: async () => ({ size: 100, isFile: () => true }), readFile: async filename => {
          reads++
          if (filename.endsWith('/package.json')) return JSON.stringify({ name: '@aspectlylabs/mikka', version: '0.0.488', gitHead: 'a'.repeat(40), credentials: 'private manifest secret' })
          return '<key>ProgramArguments</key><array><string>/private/node</string><string>/private/mikka.js</string><string>daemon</string><string>--data-dir</string><string>/owned/Mikka &amp; Dev</string><string>--dev</string></array>'
        } },
      })[name] },
    })({ app: { getPath: () => profile } }, input),
  }
  const denied = await nativeDeviceEnvironment(fake, '/somebody/else')
  assert.equal(denied.reason, 'profile-mismatch')
  assert.equal(reads, 0)
  const result = await nativeDeviceEnvironment(fake, profile)
  assert.equal(result.service.profile, 'matches')
  assert.equal(result.service.dev, true)
  assert.equal(result.service.installedVersion, '0.0.488')
  assert.equal(result.service.installedRevision, 'a'.repeat(40))
  assert.equal(result.overrideMatches, true)
  for (const secret of ['/private', '/owned', 'mikka.js', 'private manifest secret']) assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(reads, 2)
})

test('launchd bootstrap diagnostics retain only a bounded numeric code', async () => {
  for (const [reason, expected] of [
    ['Bootstrap failed: 5: Input/output error /private/path', 5],
    ['Command failed with private arguments\nBootstrap failed: 13: Permission denied', 13],
    ['Bootstrap failed: 255: private detail', 255],
    ['Bootstrap failed: 999: private detail', 'other'],
    ['Bootstrap failed: 1234567890: private detail', 'other'],
    ['Bootstrap failed: 05: private detail', 'other'],
    ['Bootstrap failed: private credential', 'other'],
    ['private credential without an OS error', null],
  ]) {
    const value = await snapshot({ ...raw, install: { ...raw.install, status: 'failed', reason } })
    assert.equal(value.installer.bootstrapErrorCode, expected)
    for (const text of ['private', 'credential', 'arguments', 'Input/output', 'Permission']) assert.equal(JSON.stringify(value).includes(text), false)
  }
})


const navigationMessage = 'page.evaluate: Execution context was destroyed, most likely because of a navigation'
const openHostedPage = { mode: 'hosted', page: { isClosed: () => false } }
const isolatedReadinessOptions = {
  profile: '/owned/profile', timeout: 1000,
  metadata: async () => ({ status: 'unavailable', reason: 'fixture-no-probe' }),
  environment: async () => ({ available: false, reason: 'fixture-no-probe' }),
}

test('one destroyed navigation context requires new leased snapshots and the unchanged ready predicate', async () => {
  let at = 0, checks = 0, attempts = 0, evidence
  const offline = await snapshot({ ...raw, device: { ...raw.device, signedIn: false } })
  const ready = await snapshot()
  await waitForNativeDevice(openHostedPage, {
    ...isolatedReadinessOptions, now: () => at, delay: async ms => { at += ms },
    scope: { assertActive: async () => { checks++ } }, record: value => { evidence = value },
    snapshot: async () => {
      attempts++
      if (attempts === 1) throw new Error(navigationMessage)
      return attempts === 2 ? offline : ready
    },
  })
  assert.equal(evidence.ready, true)
  assert.equal(checks, 3)
  assert.equal(attempts, 3)
  assert.equal(evidence.reads, 2)
  assert.equal(evidence.navigationInterruptions, 1)
  assert.equal(evidence.transitions.length, 2)
  assert.equal(evidence.transitions[0].device.signedIn, false, 'a navigation interruption cannot manufacture authenticated readiness')
  assert.equal(evidence.elapsedMs, 500)
  assert.equal(evidence.deadlineMs, 1000)
})

test('repeated destroyed navigation contexts exhaust the original deadline without passing readiness', async () => {
  let at = 0, checks = 0, attempts = 0, evidence
  await assert.rejects(waitForNativeDevice(openHostedPage, {
    ...isolatedReadinessOptions, now: () => at, delay: async ms => { at += ms },
    scope: { assertActive: async () => { checks++ } }, record: value => { evidence = value },
    snapshot: async () => { attempts++; throw new Error(navigationMessage) },
  }), { message: 'PARITY_NATIVE_DEVICE_NOT_READY' })
  assert.equal(evidence.ready, false)
  assert.equal(evidence.failure, 'deadline')
  assert.equal(evidence.deadlineMs, 1000)
  assert.equal(evidence.elapsedMs, 1000)
  assert.equal(evidence.reads, 0)
  assert.equal(evidence.navigationInterruptions, 4)
  assert.equal(checks, 4)
  assert.equal(attempts, 4)
})

test('navigation handling preserves permanent, closed-page and authentication failures verbatim', async t => {
  const cases = [
    ['permanent read failure', new Error('NATIVE_DEVICE_READ_TIMEOUT'), openHostedPage],
    ['closed page error', new Error('page.evaluate: Target page, context or browser has been closed'), openHostedPage],
    ['page already closed', new Error(navigationMessage), { mode: 'hosted', page: { isClosed: () => true } }],
    ['page openness unavailable', new Error(navigationMessage), { mode: 'hosted' }],
    ['authentication failure', new Error('AUTH_FAILURE'), openHostedPage],
    ['authentication code retains authority', Object.assign(new Error(navigationMessage), { code: 'authRequired' }), openHostedPage],
    ['authentication cause retains authority', new Error(navigationMessage, { cause: new Error('AUTH_FAILURE') }), openHostedPage],
    ['different exception kind', new TypeError(navigationMessage), openHostedPage],
  ]
  for (const [name, failure, target] of cases) await t.test(name, async () => {
    let checks = 0, attempts = 0, delays = 0, evidence
    await assert.rejects(waitForNativeDevice(target, {
      ...isolatedReadinessOptions, now: () => 0, delay: async () => { delays++ },
      scope: { assertActive: async () => { checks++ } }, record: value => { evidence = value },
      snapshot: async () => { attempts++; throw failure },
    }), error => error === failure)
    assert.equal(evidence.ready, false)
    assert.equal(evidence.reads, 0)
    assert.equal(evidence.navigationInterruptions ?? 0, 0)
    assert.equal(checks, 1)
    assert.equal(attempts, 1)
    assert.equal(delays, 0)
  })
})

test('a navigation interruption never bypasses the next fresh lease check', async () => {
  let at = 0, checks = 0, attempts = 0, evidence
  const failure = new Error('LEASE_LOST')
  await assert.rejects(waitForNativeDevice(openHostedPage, {
    ...isolatedReadinessOptions, now: () => at, delay: async ms => { at += ms },
    scope: { assertActive: async () => { if (++checks === 2) throw failure } },
    record: value => { evidence = value },
    snapshot: async () => { attempts++; throw new Error(navigationMessage) },
  }), error => error === failure)
  assert.equal(evidence.ready, false)
  assert.equal(evidence.reads, 0)
  assert.equal(evidence.navigationInterruptions, 1)
  assert.equal(evidence.elapsedMs, 250)
  assert.equal(checks, 2)
  assert.equal(attempts, 1)
})

