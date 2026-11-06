import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { authDiagnosticRoute, nativeDiagnosticFailure, nativeCleanupFailure, recordNativeCleanup, startNativeAuthDiagnostics, stopNativeAuthDiagnostics } from './native-auth-diagnostics.mjs'

const expected = { profile: '/tmp/owned-auth-profile', serverUrl: 'https://backend.example/mikka', ownerId: 'private-user-id' }
const secret = 'private-bearer-value-never-export'
const identity = { user: { id: expected.ownerId, email: 'private-email@example.test', name: 'Private User' }, session: { id: 'private-session-id' } }
const payload = () => ({ ...identity, token: secret })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Evaluate the actual inspector callback in a separate main-process-like realm,
// including its builtin-module lookup. No product parser or I/O is substituted
// by the helper itself; these stubs belong only to this focused unit test.
function inspector(options = {}) {
  const backend = { fetch: options.fetch ?? (() => Promise.resolve({ status: 200, json: () => Promise.resolve(payload()) })) }
  const handle = { writeFile: () => Promise.resolve(), sync: () => Promise.resolve(), close: () => Promise.resolve(), ...options.handle }
  const promises = { mkdir: () => Promise.resolve(), open: () => Promise.resolve(handle), rename: () => Promise.resolve(), rm: () => Promise.resolve(), ...options.promises }
  const safeStorage = { isAsyncEncryptionAvailable: () => Promise.resolve(true), encryptStringAsync: () => Promise.resolve(Buffer.from('private-ciphertext')), ...options.safeStorage }
  const contents = { send: () => undefined }
  const app = { getPath: () => options.profile ?? expected.profile }
  const electron = { app, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: contents }] },
    session: { fromPartition: () => backend }, safeStorage }
  const builtins = { 'node:fs': { existsSync: () => false }, 'node:fs/promises': promises, 'node:path': path }
  const context = vm.createContext({ Buffer, URL, process: { pid: 4171, getBuiltinModule: name => builtins[name] } })
  const application = { evaluate: async (fn, input) => {
    context.electron = electron
    context.input = input
    return await vm.runInContext(`(${fn.toString()})(electron, input)`, context)
  } }
  const events = () => JSON.parse(JSON.stringify(context.__mikkaAcceptanceAuthDiagnostics?.events ?? []))
  return { application, backend, handle, promises, safeStorage, contents, context, events }
}

async function begin(probe, state = 'private-begin-state') {
  await probe.backend.fetch(`${expected.serverUrl}/api/desktop/begin`, { method: 'POST', body: JSON.stringify({ state }) })
}

async function exchange(probe, init = {}) {
  return await probe.backend.fetch(`${expected.serverUrl}/api/desktop/exchange`, {
    method: 'POST', body: JSON.stringify({ state: 'private-begin-state', code: 'private-code', verifier: 'private-verifier' }), ...init,
  })
}

function vaultPlaintext() {
  return JSON.stringify({ version: 2, server: expected.serverUrl, value: { activeUserId: expected.ownerId,
    accounts: [{ identity, token: secret, sessionCache: 'privatecacheproof' }] } })
}

function assertNoSecrets(events) {
  const output = JSON.stringify(events)
  for (const value of [secret, expected.profile, expected.ownerId, expected.serverUrl, identity.user.email,
    identity.user.name, identity.session.id, 'private-ciphertext', 'privatecacheproof', 'private-begin-state', 'private-code', 'private-verifier']) {
    assert.equal(output.includes(value), false)
  }
}

test('authentication diagnostics use a closed route vocabulary', () => {
  for (const [path, expected] of [
    ['/mikka/api/desktop/begin', 'desktop-begin'], ['/mikka/api/desktop/return', 'desktop-return'],
    ['/mikka/api/desktop/exchange', 'desktop-exchange'], ['/mikka/api/auth/get-session', 'auth-session'],
    ['/mikka/api/auth/sign-out', 'auth-sign-out'], ['/auth/callback', 'loopback'],
    ['/mikka/en', 'root'], ['/mikka/en/sign-in', 'sign-in'],
    ['/mikka/en/a/short-secret', 'public-share'], ['/mikka/api/artifacts/shared/short-secret/frame', 'public-share-api'],
    ['/mikka/assets/short-secret.js', 'asset'], ['/private/short-secret', 'other'],
  ]) assert.equal(authDiagnosticRoute(`https://secret-host.example${path}?token=short-secret#secret`), expected)
})

test('malformed and encoded credential paths cannot escape as output', () => {
  for (const value of ['secret', 'mikka://app/mikka/api/desktop/exchange/short-secret',
    'https://example.test/mikka/api/desktop/%65xchange', 'https://example.test/short-secret',
    'https://example.test/mikka/en/a/short-secret/extra']) assert.equal(authDiagnosticRoute(value), 'other')
})

test('failure diagnostics keep only closed error categories and bounded causes', () => {
  const secret = 'a-short-secret'
  const error = new AggregateError([new Error(`https://example.test/${secret}?code=${secret}`)], secret, { cause: new Error(secret) })
  assert.deepEqual(nativeDiagnosticFailure(error), { kind: 'AggregateError', code: 'other', cause: { kind: 'Error', code: 'other' }, errors: [{ kind: 'Error', code: 'other' }] })
  assert.equal(JSON.stringify(nativeDiagnosticFailure(error)).includes(secret), false)
  assert.equal(nativeDiagnosticFailure(new Error('NATIVE_SESSION_WAIT_TIMEOUT: private details')).code, 'NATIVE_SESSION_WAIT_TIMEOUT')
})

test('exchange observation consumes only the product JSON call and preserves original promises and values', async t => {
  let reads = 0
  const body = payload()
  const parsed = Promise.resolve(body)
  const response = { status: 200, json() { assert.equal(this, response); reads++; return parsed } }
  const fetched = Promise.resolve(response)
  const probe = inspector({ fetch() { assert.equal(this, probe.backend); return fetched } })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  await begin(probe)
  const request = probe.backend.fetch(`${expected.serverUrl}/api/desktop/exchange`, { method: 'POST', body: JSON.stringify({ state: 'private-begin-state' }) })
  assert.equal(request, fetched)
  assert.equal(await request, response)
  assert.equal(reads, 0)
  assert.equal(response.json(), parsed)
  assert.equal(await parsed, body)
  await Promise.resolve()
  assert.equal(reads, 1)
  const event = probe.events().find(value => value.source === 'exchange-json' && value.phase === 'fulfilled')
  for (const key of ['userIdValid', 'sessionIdValid', 'emailShapeValid', 'nameShapeValid', 'identityValid', 'ownerMatches', 'tokenValid', 'beginObserved', 'stateMatchesLatestBegin']) assert.equal(event[key], true, key)
  for (const key of ['laterAuthRequestObserved', 'sessionChangeObserved', 'requestAborted']) assert.equal(event[key], false, key)
  assertNoSecrets(probe.events())
})

test('a real Response stays unread until the product consumes it and its inherited method is restored', async () => {
  const response = new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json' } })
  const original = response.json
  const probe = inspector({ fetch: () => Promise.resolve(response) })
  await startNativeAuthDiagnostics(probe.application, expected)
  try {
    await exchange(probe)
    assert.equal(response.bodyUsed, false)
    assert.deepEqual(await response.json(), payload())
    assert.equal(response.bodyUsed, true)
    assert.equal(probe.events().filter(value => value.source === 'exchange-json' && value.phase === 'fulfilled').length, 1)
    assertNoSecrets(probe.events())
  } finally { await stopNativeAuthDiagnostics(probe.application) }
  assert.equal(response.json, original)
  assert.equal(Object.hasOwn(response, 'json'), false)
})

test('JSON parse and invalid identity failures stay distinguishable without exporting response data', async t => {
  const parseError = new SyntaxError(`malformed ${secret}`)
  parseError.code = `unknown-${secret}`
  const parsed = deferred()
  const response = { status: 200, json: () => parsed.promise }
  const probe = inspector({ fetch: () => Promise.resolve(response) })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  await begin(probe)
  await exchange(probe)
  assert.equal(response.json(), parsed.promise)
  parsed.reject(parseError)
  await assert.rejects(parsed.promise, error => error === parseError)
  const failed = probe.events().find(value => value.source === 'exchange-json' && value.phase === 'rejected')
  assert.deepEqual(failed.error, { kind: 'SyntaxError', code: 'other' })
  assertNoSecrets(probe.events())
})

test('parsed response shape and observed superseding attempts are closed booleans, not an invented generation', async t => {
  const body = { ...payload(), token: `${secret}\r\n`, user: { ...identity.user, name: 1 }, session: { id: '' } }
  const parsed = deferred()
  const response = { status: 200, json: () => parsed.promise }
  const probe = inspector({ fetch: () => Promise.resolve(response) })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  await begin(probe)
  const controller = new AbortController()
  await exchange(probe, { signal: controller.signal })
  response.json()
  await begin(probe, 'private-new-state')
  probe.contents.send('bundled:session-changed')
  controller.abort()
  parsed.resolve(body)
  assert.equal(await parsed.promise, body)
  const event = probe.events().find(value => value.source === 'exchange-json' && value.phase === 'fulfilled')
  assert.equal(event.tokenValid, false)
  assert.equal(event.identityValid, false)
  assert.equal(event.nameShapeValid, false)
  assert.equal(event.sessionIdValid, false)
  assert.equal(event.laterAuthRequestObserved, true)
  assert.equal(event.sessionChangeObserved, true)
  assert.equal(event.requestAborted, true)
  assert.equal('generation' in event, false)
  assertNoSecrets(probe.events())
})

test('real availability and encrypt calls are observed without additional calls or substituted output', async t => {
  const cipher = Buffer.from('private-ciphertext')
  const encrypted = Promise.resolve(cipher)
  const availability = Promise.resolve(true)
  let encryptCalls = 0
  let availabilityCalls = 0
  const plaintext = vaultPlaintext()
  const probe = inspector({ safeStorage: {
    isAsyncEncryptionAvailable() { availabilityCalls++; assert.equal(this, probe.safeStorage); return availability },
    encryptStringAsync(value) { encryptCalls++; assert.equal(value, plaintext); assert.equal(this, probe.safeStorage); return encrypted },
  } })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  assert.equal(availabilityCalls, 0)
  assert.equal(encryptCalls, 0)
  await begin(probe)
  await (await exchange(probe)).json()
  assert.equal(probe.safeStorage.isAsyncEncryptionAvailable(), availability)
  assert.equal(probe.safeStorage.encryptStringAsync(plaintext), encrypted)
  assert.equal(await encrypted, cipher)
  await Promise.resolve()
  assert.equal(availabilityCalls, 1)
  assert.equal(encryptCalls, 1)
  const input = probe.events().find(value => value.source === 'vault-encrypt-input')
  for (const key of ['identityValid', 'ownerMatches', 'tokenValid', 'accountCountWithinLimit', 'exchangeObserved', 'exchangeOwnerMatches', 'exchangeSessionMatches', 'exchangeTokenMatches']) assert.equal(input[key], true, key)
  assert.equal(input.laterAuthRequestObserved, false)
  const output = probe.events().find(value => value.source === 'vault-encrypt' && value.phase === 'fulfilled')
  assert.equal(output.ciphertextIsBuffer, true)
  assert.equal(output.ciphertextWithinLimit, true)
  const previousEvents = probe.events().length
  assert.equal(await probe.context.__mikkaAcceptanceAuthDiagnostics.keychainAvailable(), true)
  assert.equal(probe.events().length, previousEvents, 'the final diagnostic snapshot must not look like a product availability call')
  assertNoSecrets(probe.events())
})

test('encryption rejection and synchronous native exceptions keep the same error objects', async t => {
  const nativeError = Object.assign(new Error(`native ${secret}`), { code: 'EPERM' })
  const encryption = deferred()
  const probe = inspector({ safeStorage: {
    encryptStringAsync: () => encryption.promise,
    isAsyncEncryptionAvailable() { throw nativeError },
  } })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  assert.throws(() => probe.safeStorage.isAsyncEncryptionAvailable(), error => error === nativeError)
  assert.equal(probe.safeStorage.encryptStringAsync(vaultPlaintext()), encryption.promise)
  encryption.reject(nativeError)
  await assert.rejects(encryption.promise, error => error === nativeError)
  const events = probe.events().filter(value => ['threw', 'rejected'].includes(value.phase))
  assert.deepEqual(events.map(value => [value.source, value.phase, value.error]), [
    ['vault-availability', 'threw', { kind: 'Error', code: 'EPERM' }],
    ['vault-encrypt', 'rejected', { kind: 'Error', code: 'EPERM' }],
  ])
  assertNoSecrets(probe.events())
})

test('file observation is restricted to the exact owned vault and its PID temporary file', async t => {
  const directory = path.join(expected.profile, 'credentials')
  const final = path.join(directory, 'desktop-session.bin')
  const temporary = `${final}.4171.tmp`
  const write = deferred()
  const writeError = Object.assign(new Error(`${temporary}: ${secret}`), { code: 'ENOSPC' })
  const renameError = Object.assign(new Error(`${final}: ${secret}`), { code: 'EACCES' })
  const mkdir = Promise.resolve(undefined)
  const opened = deferred()
  let openArgs
  const probe = inspector({ handle: { writeFile() { assert.equal(this, probe.handle); return write.promise } }, promises: {
    mkdir() { assert.equal(this, probe.promises); return mkdir },
    open(...args) { assert.equal(this, probe.promises); openArgs = args; return opened.promise },
    rename() { throw renameError },
  } })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  await probe.promises.mkdir(`${directory}/unrelated`)
  probe.promises.open(`${final}.different-pid.tmp`, 1, 0o600)
  assert.throws(() => probe.promises.rename(`${temporary}-foreign`, final), error => error === renameError)
  assert.equal(probe.events().length, 0)
  assert.equal(probe.promises.mkdir(directory, { recursive: true, mode: 0o700 }), mkdir)
  assert.equal(probe.promises.open(temporary, 123, 0o600), opened.promise)
  assert.deepEqual(openArgs, [temporary, 123, 0o600])
  opened.resolve(probe.handle)
  assert.equal(await opened.promise, probe.handle)
  assert.equal(probe.handle.writeFile(Buffer.from('private-ciphertext')), write.promise)
  write.reject(writeError)
  await assert.rejects(write.promise, error => error === writeError)
  await probe.handle.sync()
  await probe.handle.close()
  assert.throws(() => probe.promises.rename(temporary, final), error => error === renameError)
  await probe.promises.rm(final, { force: true })
  const failures = probe.events().filter(value => value.phase === 'threw' || value.phase === 'rejected')
  assert.deepEqual(failures.map(value => [value.operation, value.error.code]), [['write', 'ENOSPC'], ['rename', 'EACCES']])
  for (const operation of ['mkdir', 'open-temporary', 'write', 'sync', 'close', 'rename', 'remove-final']) assert.ok(probe.events().some(value => value.operation === operation), operation)
  assertNoSecrets(probe.events())
})

test('each vault I/O rejection is attributed to its exact stage with the original rejection preserved', async t => {
  const directory = path.join(expected.profile, 'credentials')
  const final = path.join(directory, 'desktop-session.bin')
  const temporary = `${final}.4171.tmp`
  for (const [name, operation, args, onHandle] of [
    ['mkdir', 'mkdir', [directory]], ['open', 'open-temporary', [temporary]],
    ['writeFile', 'write', [Buffer.from('private-ciphertext')], true], ['sync', 'sync', [], true], ['close', 'close', [], true],
    ['rename', 'rename', [temporary, final]], ['rm', 'remove-final', [final]],
  ]) await t.test(operation, async () => {
    const originalError = Object.assign(new Error(`${secret}: ${temporary}`), { code: 'EIO' })
    const failed = deferred()
    const probe = inspector({ [onHandle ? 'handle' : 'promises']: { [name]: () => failed.promise } })
    await startNativeAuthDiagnostics(probe.application, expected)
    try {
      if (onHandle) await probe.promises.open(temporary)
      assert.equal((onHandle ? probe.handle : probe.promises)[name](...args), failed.promise)
      failed.reject(originalError)
      await assert.rejects(failed.promise, error => error === originalError)
      const event = probe.events().find(value => value.operation === operation && value.phase === 'rejected')
      assert.deepEqual(event.error, { kind: 'Error', code: 'EIO' })
      assertNoSecrets(probe.events())
    } finally { await stopNativeAuthDiagnostics(probe.application) }
  })
})

test('non-writable observation targets do not alter the original call and report only observer availability', async t => {
  const probe = inspector()
  const original = probe.promises.mkdir
  Object.defineProperty(probe.promises, 'mkdir', { value: original, writable: false, configurable: false })
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  assert.equal(probe.promises.mkdir, original)
  assert.equal(await probe.promises.mkdir(path.join(expected.profile, 'credentials')), undefined)
  assert.deepEqual(probe.events().map(({ at: _at, ...event }) => event), [{ source: 'observer', operation: 'mkdir', phase: 'unavailable' }])
})

test('stop restores descriptors and pending calls cannot install later observation wrappers', async () => {
  const fetching = deferred()
  const opening = deferred()
  const response = { status: 200, json: () => Promise.resolve(payload()) }
  const probe = inspector({ fetch: () => fetching.promise, promises: { open: () => opening.promise } })
  const originals = [probe.backend.fetch, probe.safeStorage.encryptStringAsync, probe.safeStorage.isAsyncEncryptionAvailable,
    probe.promises.mkdir, probe.promises.open, probe.promises.rename, probe.promises.rm, probe.contents.send, probe.handle.writeFile]
  await startNativeAuthDiagnostics(probe.application, expected)
  const request = probe.backend.fetch(`${expected.serverUrl}/api/desktop/exchange`, { method: 'POST' })
  probe.promises.open(path.join(expected.profile, 'credentials', 'desktop-session.bin.4171.tmp'))
  await stopNativeAuthDiagnostics(probe.application)
  fetching.resolve(response)
  opening.resolve(probe.handle)
  assert.equal(await request, response)
  await opening.promise
  assert.deepEqual([probe.backend.fetch, probe.safeStorage.encryptStringAsync, probe.safeStorage.isAsyncEncryptionAvailable,
    probe.promises.mkdir, probe.promises.open, probe.promises.rename, probe.promises.rm, probe.contents.send, probe.handle.writeFile], originals)
  assert.equal(probe.context.__mikkaAcceptanceAuthDiagnostics, undefined)
  assert.equal(response.json.name, 'json')
})

test('observation refuses another profile and keeps a bounded closed event stream', async t => {
  const foreign = inspector({ profile: '/tmp/another-profile' })
  const original = foreign.backend.fetch
  await assert.rejects(startNativeAuthDiagnostics(foreign.application, expected), /NATIVE_AUTH_DIAGNOSTICS_UNAVAILABLE/)
  assert.equal(foreign.backend.fetch, original)
  const probe = inspector()
  await startNativeAuthDiagnostics(probe.application, expected)
  t.after(() => stopNativeAuthDiagnostics(probe.application))
  for (let index = 0; index < 210; index++) await probe.backend.fetch(`https://foreign.example/private/${secret}`, { method: 'GET' })
  assert.equal(probe.events().length, 200)
  assert.equal(probe.context.__mikkaAcceptanceAuthDiagnostics.overflow(), true)
  assert.ok(probe.events().every(value => value.route === 'other'))
  assertNoSecrets(probe.events())
})

test('cleanup stages preserve asynchronous completion and the exact original release error', async () => {
  const records = []
  const closing = deferred()
  const close = recordNativeCleanup('browser-close', () => closing.promise, records)
  assert.deepEqual(records, [{ stage: 'browser-close', result: 'running' }])
  const closedValue = {}
  closing.resolve(closedValue)
  assert.equal(await close, closedValue)

  let sensitiveReads = 0
  const failure = { name: 'TestAccountError', code: 'ACCOUNT_DIRTY' }
  for (const key of ['message', 'stack']) Object.defineProperty(failure, key, { get() { sensitiveReads++; throw new Error('must not read private text') } })
  const releasing = deferred()
  const release = recordNativeCleanup('lease-release', () => releasing.promise, records)
  const rejected = assert.rejects(release, error => error === failure)
  releasing.reject(failure)
  await rejected
  assert.deepEqual(records, [
    { stage: 'browser-close', result: 'passed' },
    { stage: 'lease-release', result: 'failed', error: { kind: 'TestAccountError', code: 'ACCOUNT_DIRTY' } },
  ])
  assert.equal(sensitiveReads, 0)
})

test('cleanup projection retains closed browser and aggregate causes without message or identifiers', async () => {
  const browser = Object.assign(new Error(secret), { name: 'TimeoutError', code: secret, requestId: secret })
  const lease = Object.assign(new Error(secret), { name: 'TestAccountError', code: 'LEASE_LOST' })
  const aggregate = new AggregateError([browser, lease, browser, lease, browser], secret, { cause: lease })
  const records = []
  await assert.rejects(recordNativeCleanup('browser-close', () => { throw browser }, records), error => error === browser)
  assert.deepEqual(records[0], { stage: 'browser-close', result: 'failed', error: { kind: 'TimeoutError', code: 'other' } })
  const diagnostic = nativeCleanupFailure(aggregate)
  assert.equal(diagnostic.kind, 'AggregateError')
  assert.equal(diagnostic.errors.length, 4)
  assert.deepEqual(diagnostic.cause, { kind: 'TestAccountError', code: 'LEASE_LOST' })
  for (const [name, codes] of [
    ['TestAccountError', ['ACCOUNT_DIRTY', 'ACCOUNT_POOL_DATABASE_ERROR', 'LEASE_LOST', 'LEASE_CLOSED',
      'SESSION_STATE_RETENTION_FAILED', 'INVALID_REQUEST', 'STALE_LEASE', 'SESSION_REVOCATION_NOT_AUTHORIZED',
      'RESOURCE_NOT_OWNED', 'RESOURCE_OWNER_MISMATCH', 'ACCOUNT_FOOTPRINT_UNPROVEN']],
    ['EnvironmentError', ['ACTUAL_DATABASE_MISMATCH', 'DATABASE_IDENTITY_MISMATCH', 'DATABASE_IDENTITY_UNAVAILABLE',
      'DOCKER_DESCRIPTOR_SIGNING_INVALID', 'DOCKER_DESCRIPTOR_SIGNATURE_MISMATCH',
      'DOCKER_TARGET_FORBIDDEN', 'DOCKER_PUBLICATION_MISMATCH']],
  ]) {
    for (const code of codes) assert.deepEqual(nativeCleanupFailure({ name, code, message: secret }), { kind: name, code })
  }
  // These are persisted quarantine reasons, not errors thrown by release.
  for (const code of ['RUN_DIRTY', 'RUN_CANCELLED', 'RESOURCES_NOT_CLEANED', 'ACCOUNT_SESSION_STILL_ACTIVE']) {
    assert.deepEqual(nativeCleanupFailure({ name: 'TestAccountError', code }), { kind: 'TestAccountError', code: 'other' })
  }
  assert.ok(!JSON.stringify(diagnostic).includes(secret))
  const cycle = { name: 'Error', code: 'ECONNRESET' }
  cycle.cause = cycle
  assert.deepEqual(nativeCleanupFailure(cycle), { kind: 'Error', code: 'ECONNRESET', cause: { kind: 'Error', code: 'ECONNRESET', cause: { kind: 'Error', code: 'ECONNRESET' } } })
})

test('cleanup diagnostics refuse unknown stages and never replace the original rejection', async () => {
  const records = []
  let calls = 0
  await assert.rejects(recordNativeCleanup(secret, () => { calls++ }, records), { code: 'ERR_ASSERTION' })
  assert.equal(calls, 0)
  assert.deepEqual(records, [])
  const failure = { get code() { throw new Error(secret) } }
  await assert.rejects(recordNativeCleanup('electron-close', () => Promise.reject(failure), records), error => error === failure)
  assert.deepEqual(records, [{ stage: 'electron-close', result: 'failed', error: { kind: 'other', code: 'other' } }])
})

test('fixture cleanup retains its exact rejection and exposes only existing ownership guard codes', async () => {
  const records = []
  const value = {}
  assert.equal(await recordNativeCleanup('fixtures', async () => value, records), value)
  for (const code of ['PARITY_READ_OWNERSHIP_UNPROVEN', 'PARITY_READ_CHANGED',
    'PARITY_DEFAULT_CLOCK_UNPROVEN', 'PARITY_DEFAULT_OWNERSHIP_UNPROVEN', 'PARITY_DEFAULT_CHANGED']) {
    const failure = { name: 'TestAccountError', code }
    for (const key of ['message', 'stack']) Object.defineProperty(failure, key, {
      get() { assert.fail('fixture diagnostic must not read private row values or SQL details') },
    })
    await assert.rejects(recordNativeCleanup('fixtures', async () => { throw failure }, records), error => error === failure)
    assert.deepEqual(records.at(-1), { stage: 'fixtures', result: 'failed', error: { kind: 'TestAccountError', code } })
  }
  assert.deepEqual(records[0], { stage: 'fixtures', result: 'passed' })
})
