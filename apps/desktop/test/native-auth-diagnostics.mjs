import assert from 'node:assert/strict'

// A closed vocabulary, not a redaction heuristic. Unknown paths, hostnames,
// query strings, headers and bodies never become diagnostic output.
const ROUTES = [
  ['^/mikka/api/desktop/begin$', 'desktop-begin'],
  ['^/mikka/api/desktop/return$', 'desktop-return'],
  ['^/mikka/api/desktop/complete$', 'desktop-complete'],
  ['^/mikka/api/desktop/exchange$', 'desktop-exchange'],
  ['^/mikka/api/desktop/rpc$', 'desktop-rpc'],
  ['^/mikka/api/desktop/config$', 'desktop-config'],
  ['^/mikka/api/auth/sign-in/email$', 'auth-email'],
  ['^/mikka/api/auth/get-session$', 'auth-session'],
  ['^/mikka/api/auth/sign-out$', 'auth-sign-out'],
  ['^/auth/callback$', 'loopback'],
  ['^/mikka(?:/en)?/?$', 'root'],
  ['^/mikka(?:/en)?/sign-in$', 'sign-in'],
  ['^/mikka(?:/en)?/sign-up$', 'sign-up'],
  ['^/mikka(?:/en)?/a/[^/]+$', 'public-share'],
  ['^/mikka/api/artifacts/shared/[^/]+(?:/frame)?$', 'public-share-api'],
  ['^/mikka/(?:assets|_next)/', 'asset'],
]

export function authDiagnosticRoute(value) {
  try {
    const path = new URL(value).pathname
    return ROUTES.find(([pattern]) => new RegExp(pattern).test(path))?.[1] ?? 'other'
  } catch { return 'other' }
}

export function nativeDiagnosticFailure(error, depth = 0) {
  const codes = ['NATIVE_SESSION_WAIT_TIMEOUT', 'NATIVE_SESSION_IDENTITY_MISMATCH', 'NATIVE_SESSION_READ_TIMEOUT',
    'NATIVE_INSTALLER_CANCEL_TIMEOUT', 'NATIVE_INSTALLER_STILL_RUNNING', 'NATIVE_DAEMON_STOP_UNPROVEN',
    'NATIVE_DAEMON_DRAIN_TIMEOUT', 'NATIVE_DAEMON_SOCKET_CLOSE_TIMEOUT', 'NATIVE_DAEMON_EXIT_TIMEOUT',
    'NATIVE_AUTH_DIAGNOSTICS_UNAVAILABLE', 'PARITY_NATIVE_DEVICE_NOT_READY', 'LEASE_LOST', 'LEASE_CLOSED',
    'ACCOUNT_DIRTY', 'ERR_ASSERTION', 'ECONNREFUSED', 'ENOENT', 'EACCES']
  const code = codes.find(value => error?.code === value || error?.message === value || (typeof error?.message === 'string' && error.message.startsWith(`${value}:`))) ?? 'other'
  return { kind: ['Error', 'AssertionError', 'TimeoutError', 'TestAccountError', 'AggregateError', 'TypeError'].includes(error?.name) ? error.name : 'other', code,
    ...(depth < 2 && error?.cause ? { cause: nativeDiagnosticFailure(error.cause, depth + 1) } : {}),
    ...(depth < 2 && Array.isArray(error?.errors) ? { errors: error.errors.slice(0, 4).map(value => nativeDiagnosticFailure(value, depth + 1)) } : {}) }
}


const CLEANUP_STAGES = ['browser-close', 'electron-close', 'daemon-drain', 'native-resources', 'lease-release']
const CLEANUP_ERROR_CODES = new Set([
  'ACCOUNT_DIRTY', 'ACCOUNT_POOL_DATABASE_ERROR', 'LEASE_LOST', 'LEASE_CLOSED',
  'SESSION_STATE_RETENTION_FAILED', 'INVALID_REQUEST', 'STALE_LEASE',
  'SESSION_REVOCATION_NOT_AUTHORIZED', 'RESOURCE_NOT_OWNED', 'RESOURCE_OWNER_MISMATCH',
  'ACCOUNT_FOOTPRINT_UNPROVEN',
  // Every pool transaction verifies the existing database/descriptor binding.
  'ACTUAL_DATABASE_MISMATCH', 'DATABASE_IDENTITY_MISMATCH', 'DATABASE_IDENTITY_UNAVAILABLE',
  'DOCKER_DESCRIPTOR_SIGNING_INVALID', 'DOCKER_DESCRIPTOR_SIGNATURE_MISMATCH',
  'DOCKER_TARGET_FORBIDDEN', 'DOCKER_PUBLICATION_MISMATCH',
  'ERR_ASSERTION', 'ECONNREFUSED', 'ECONNRESET',
  'EPIPE', 'ENOENT', 'EACCES', 'EPERM',
])
const CLEANUP_ERROR_NAMES = new Set(['Error', 'AssertionError', 'TimeoutError', 'TestAccountError', 'EnvironmentError', 'AggregateError', 'TypeError'])

/** Cleanup errors can contain credentials in message/stack or nested causes.
 * Only exact known code/name values and a bounded cause chain leave the test. */
export function nativeCleanupFailure(error, depth = 0) {
  try {
    return {
      kind: CLEANUP_ERROR_NAMES.has(error?.name) ? error.name : 'other',
      code: CLEANUP_ERROR_CODES.has(error?.code) ? error.code : 'other',
      ...(depth < 2 && error?.cause ? { cause: nativeCleanupFailure(error.cause, depth + 1) } : {}),
      ...(depth < 2 && Array.isArray(error?.errors) ? { errors: error.errors.slice(0, 4).map(value => nativeCleanupFailure(value, depth + 1)) } : {}),
    }
  } catch { return { kind: 'other', code: 'other' } }
}

/** Observe the existing cleanup call; preserve its result or original rejection. */
export async function recordNativeCleanup(stage, action, records) {
  assert.ok(CLEANUP_STAGES.includes(stage), 'NATIVE_CLEANUP_DIAGNOSTIC_STAGE_REQUIRED')
  const record = { stage, result: 'running' }
  records.push(record)
  try {
    const result = await action()
    record.result = 'passed'
    return result
  } catch (error) {
    record.result = 'failed'
    record.error = nativeCleanupFailure(error)
    throw error
  }
}

/** Test inspector only; observes the actual transport without changing any
 * request/response. Stop before further UI work. Publish only on failure. */
export async function startNativeAuthDiagnostics(application, expected) {
  const result = await application.evaluate(({ app, BrowserWindow, session, safeStorage }, input) => {
    if (app.getPath('userData') !== input.expected.profile || globalThis.__mikkaAcceptanceAuthDiagnostics) return { started: false }
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) return { started: false }
    const fs = process.getBuiltinModule('node:fs')
    const promises = process.getBuiltinModule('node:fs/promises')
    const path = process.getBuiltinModule('node:path')
    if (!path.isAbsolute(input.expected.profile) || path.resolve(input.expected.profile) !== input.expected.profile) return { started: false }
    const backend = session.fromPartition('persist:mikka-dev-bundled-backend')
    const originalFetch = backend.fetch
    const originalSend = window.webContents.send
    const originalAvailable = safeStorage.isAsyncEncryptionAvailable
    const directory = path.join(input.expected.profile, 'credentials')
    const file = path.join(directory, 'desktop-session.bin')
    const temporary = `${file}.${process.pid}.tmp`
    const events = []
    const restorers = []
    let overflow = false
    let stopped = false
    let authAttempt = 0
    let latestBeginState = null
    let sessionChanges = 0
    let exchangeIdentity = null
    const classify = value => {
      try {
        const pathname = new URL(value).pathname
        return input.routes.find(([pattern]) => new RegExp(pattern).test(pathname))?.[1] ?? 'other'
      } catch { return 'other' }
    }
    const add = value => {
      if (stopped) return
      if (events.length < 200) events.push({ at: Date.now(), ...value })
      else overflow = true
    }
    const failure = error => {
      const kinds = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']
      const codes = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ELOOP', 'EMFILE', 'ENFILE',
        'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EBADF', 'EINVAL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
        'ERR_FS_FILE_TOO_LARGE', 'ERR_FS_FILE_TOO_LARGE_TO_READ', 'ABORT_ERR']
      return { kind: kinds.includes(error?.name) ? error.name : 'other', code: codes.includes(error?.code) ? error.code : 'other' }
    }
    // Observe the real call without awaiting, substituting a promise, consuming
    // another body, or converting its exception. Observer failures stay local.
    const quietly = work => { try { work() } catch { /* Diagnostics cannot change the product result. */ } }
    const watch = (value, fulfilled, rejected) => {
      quietly(() => {
        if (value && typeof value.then === 'function') value.then(
          result => quietly(() => { if (!stopped) fulfilled(result) }), error => quietly(() => { if (!stopped) rejected(error) }),
        )
        else if (!stopped) fulfilled(value)
      })
      return value
    }
    const replace = (object, name, wrapper, operation) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, name)
      try {
        Object.defineProperty(object, name, descriptor && 'value' in descriptor ? { ...descriptor, value: wrapper }
          : { value: wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? false })
        restorers.push(() => {
          if (object[name] !== wrapper) return
          if (descriptor) Object.defineProperty(object, name, descriptor)
          else delete object[name]
        })
      } catch { add({ source: 'observer', operation, phase: 'unavailable' }) }
    }
    const observeCall = (source, operation, original, receiver, args, details = () => ({})) => {
      quietly(() => add({ source, operation, phase: 'start' }))
      let value
      try { value = Reflect.apply(original, receiver, args) } catch (error) {
        quietly(() => add({ source, operation, phase: 'threw', error: failure(error) }))
        throw error
      }
      return watch(value,
        result => add({ source, operation, phase: 'fulfilled', ...details(result) }),
        error => add({ source, operation, phase: 'rejected', error: failure(error) }))
    }
    const identityChecks = value => {
      const user = value?.user
      const session = value?.session
      const userIdValid = typeof user?.id === 'string' && user.id.length > 0 && user.id.length <= 200
      const sessionIdValid = typeof session?.id === 'string' && session.id.length > 0 && session.id.length <= 200
      const emailShapeValid = typeof user?.email === 'string' && user.email.length <= 320
      const nameShapeValid = typeof user?.name === 'string' && user.name.length <= 500
      return { userIdValid, sessionIdValid, emailShapeValid, nameShapeValid,
        identityValid: !!value && typeof value === 'object' && userIdValid && sessionIdValid && emailShapeValid && nameShapeValid,
        ownerMatches: user?.id === input.expected.ownerId }
    }
    // These are the production parser's shape checks, reported only as booleans.
    const tokenValid = value => typeof value === 'string' && value.length >= 16 && value.length <= 4096
      // oxlint-disable-next-line no-control-regex -- Match the actual main-process credential validation without exporting a credential.
      && !/[\s\x00-\x1f\x7f]/.test(value)
    const requestState = init => {
      try {
        if (typeof init?.body !== 'string' || init.body.length > 8192) return null
        const value = JSON.parse(init.body).state
        return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
      } catch { return null }
    }
    const currentProfile = () => app.getPath('userData') === input.expected.profile
    const exactBackend = value => {
      try { return new URL(value).origin === new URL(input.expected.serverUrl).origin } catch { return false }
    }
    replace(backend, 'fetch', function (request, init) {
      const route = classify(typeof request === 'string' ? request : request.url)
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET') ? (init?.method ?? 'GET') : 'other'
      const owned = currentProfile() && exactBackend(typeof request === 'string' ? request : request.url)
      if (owned && method === 'POST' && ['desktop-begin', 'auth-email', 'auth-sign-out'].includes(route)) {
        authAttempt++
        latestBeginState = route === 'desktop-begin' ? requestState(init) : null
      }
      const attempt = authAttempt
      const changes = sessionChanges
      const beginObserved = latestBeginState !== null
      const stateMatchesLatestBegin = beginObserved && requestState(init) === latestBeginState
      // Internal BundledAuth.generation is deliberately not inspected. These
      // facts reveal superseding observed auth requests and aborts, not its value.
      const attemptChecks = () => ({ beginObserved, stateMatchesLatestBegin,
        laterAuthRequestObserved: authAttempt !== attempt, sessionChangeObserved: sessionChanges !== changes,
        requestAborted: init?.signal?.aborted === true })
      let value
      try { value = Reflect.apply(originalFetch, this, arguments) } catch (error) {
        quietly(() => add({ source: 'main-fetch', route, method, status: 0, error: failure(error) }))
        throw error
      }
      return watch(value, response => {
        add({ source: 'main-fetch', route, method, status: response.status })
        if (!owned || route !== 'desktop-exchange' || method !== 'POST') return
        const originalJson = response.json
        replace(response, 'json', function () {
          return observeCall('exchange-json', 'parse', originalJson, this, arguments, body => {
            const checks = { ...identityChecks(body), tokenValid: tokenValid(body?.token), ...attemptChecks() }
            exchangeIdentity = { attempt, token: body?.token, userId: body?.user?.id, sessionId: body?.session?.id }
            return checks
          })
        }, 'exchange-json')
      }, error => add({ source: 'main-fetch', route, method, status: 0, error: failure(error) }))
    }, 'backend-fetch')
    replace(safeStorage, 'isAsyncEncryptionAvailable', function () {
      return observeCall('vault-availability', 'available', originalAvailable, this, arguments, result => ({ available: result === true }))
    }, 'vault-availability')
    const originalEncrypt = safeStorage.encryptStringAsync
    replace(safeStorage, 'encryptStringAsync', function (plaintext) {
      let envelope
      quietly(() => { if (currentProfile() && typeof plaintext === 'string' && plaintext.length <= 256 * 1024) envelope = JSON.parse(plaintext) })
      if (envelope?.version !== 2 || envelope.server !== input.expected.serverUrl || !Array.isArray(envelope.value?.accounts)) return Reflect.apply(originalEncrypt, this, arguments)
      const active = envelope.value.accounts.find(account => account?.identity?.user?.id === envelope.value.activeUserId)
      const checks = { ...identityChecks(active?.identity), tokenValid: tokenValid(active?.token),
        accountCountWithinLimit: envelope.value.accounts.length > 0 && envelope.value.accounts.length <= 5,
        exchangeObserved: exchangeIdentity !== null,
        exchangeOwnerMatches: exchangeIdentity !== null && exchangeIdentity.userId === active?.identity?.user?.id,
        exchangeSessionMatches: exchangeIdentity !== null && exchangeIdentity.sessionId === active?.identity?.session?.id,
        exchangeTokenMatches: exchangeIdentity !== null && exchangeIdentity.token === active?.token,
        laterAuthRequestObserved: exchangeIdentity !== null && exchangeIdentity.attempt !== authAttempt }
      add({ source: 'vault-encrypt-input', ...checks })
      return observeCall('vault-encrypt', 'encrypt', originalEncrypt, this, arguments,
        result => ({ ciphertextIsBuffer: Buffer.isBuffer(result), ciphertextWithinLimit: Buffer.isBuffer(result) && result.length <= 128 * 1024 }))
    }, 'vault-encrypt')
    const wrapFileOperation = (name, matches, operation, fulfilled) => {
      const original = promises[name]
      replace(promises, name, function () {
        if (!currentProfile() || !matches(...arguments)) return Reflect.apply(original, this, arguments)
        return observeCall('vault-file', operation, original, this, arguments, result => { fulfilled?.(result); return {} })
      }, operation)
    }
    wrapFileOperation('mkdir', target => target === directory, 'mkdir')
    wrapFileOperation('open', target => target === temporary, 'open-temporary', handle => {
      for (const [name, operation] of [['writeFile', 'write'], ['sync', 'sync'], ['close', 'close']]) {
        const original = handle[name]
        replace(handle, name, function () { return observeCall('vault-file', operation, original, this, arguments) }, operation)
      }
    })
    wrapFileOperation('rename', (source, destination) => source === temporary && destination === file, 'rename')
    wrapFileOperation('rm', target => target === file, 'remove-final')
    replace(window.webContents, 'send', function (channel) {
      quietly(() => {
        if (channel === 'bundled:session-changed') { sessionChanges++; add({ source: 'session-change', vaultExists: fs.existsSync(file) }) }
      })
      return Reflect.apply(originalSend, this, arguments)
    }, 'session-send')
    globalThis.__mikkaAcceptanceAuthDiagnostics = {
      expected: input.expected, events, file, classify,
      overflow: () => overflow,
      keychainAvailable: () => Reflect.apply(originalAvailable, safeStorage, []),
      restore() {
        stopped = true
        for (const restore of restorers.reverse()) quietly(restore)
        latestBeginState = null
        exchangeIdentity = null
        delete globalThis.__mikkaAcceptanceAuthDiagnostics
      },
    }
    return { started: true }
  }, { expected, routes: ROUTES })
  assert.equal(result.started, true, 'NATIVE_AUTH_DIAGNOSTICS_UNAVAILABLE')
}

export async function readNativeAuthDiagnostics(application) {
  return await application.evaluate(async ({ app, BrowserWindow, safeStorage }) => {
    const probe = globalThis.__mikkaAcceptanceAuthDiagnostics
    if (!probe || app.getPath('userData') !== probe.expected.profile) return { available: false }
    const fs = process.getBuiltinModule('node:fs/promises')
    const { constants } = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const bounded = async promise => {
      let timer
      try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DIAGNOSTIC_TIMEOUT')), 3000) })])
      } finally { clearTimeout(timer) }
    }
    const windows = []
    for (const window of BrowserWindow.getAllWindows().slice(0, 4)) {
      if (window.isDestroyed()) continue
      let renderer = { readable: false }
      try {
        const value = await bounded(window.webContents.executeJavaScript(`(async () => ({ url: location.href,
          bridge: !!window.mikka, bundled: !!window.mikka?.bundled,
          sessionFunction: typeof window.mikka?.bundled?.session === 'function',
          identity: await window.mikka?.bundled?.session?.() ?? null }))()`))
        const url = new URL(value.url)
        const originKind = url.protocol === 'mikka:' && url.hostname === 'app' ? 'local-app'
          : url.origin === new URL(probe.expected.serverUrl).origin ? 'backend'
            : ['127.0.0.1', 'localhost'].includes(url.hostname) ? 'loopback' : 'other'
        renderer = { readable: true,
          protocol: ['mikka:', 'https:', 'http:', 'file:', 'about:'].includes(url.protocol) ? url.protocol : 'other',
          originKind, route: probe.classify(value.url), bridge: value.bridge, bundled: value.bundled,
          sessionFunction: value.sessionFunction, sessionPresent: !!value.identity,
          ownerMatches: value.identity?.user?.id === probe.expected.ownerId }
      } catch { /* A navigation/closed frame is represented only by a boolean. */ }
      windows.push({ visible: window.isVisible(), ...renderer })
    }
    const vault = { exists: false, readable: false, ownerMatches: false, accountCount: 0, bearerPresent: false, cachePresent: false }
    try {
      const profile = await fs.realpath(probe.expected.profile)
      if (await fs.realpath(path.dirname(probe.file)) !== path.join(profile, 'credentials')) throw new Error('UNSAFE_PROFILE')
      const file = await fs.open(probe.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      let encrypted
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 128 * 1024 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('UNSAFE_VAULT')
        vault.exists = true
        encrypted = await file.readFile()
      } finally { await file.close() }
      // Neither plaintext nor ciphertext leaves Electron main.
      const value = JSON.parse((await bounded(safeStorage.decryptStringAsync(encrypted))).result)
      if (value.version !== 2 || value.server !== probe.expected.serverUrl || !Array.isArray(value.value?.accounts) || value.value.accounts.length > 5) throw new Error('INVALID_VAULT')
      vault.readable = true
      vault.accountCount = value.value.accounts.length
      const account = value.value.accounts.find(account => account.identity?.user?.id === value.value.activeUserId)
      vault.ownerMatches = account?.identity?.user?.id === probe.expected.ownerId
      vault.bearerPresent = typeof account?.token === 'string' && account.token.length >= 16
      vault.cachePresent = typeof account?.sessionCache === 'string' && account.sessionCache.length >= 16
    } catch { /* No native error message or secret crosses the inspector. */ }
    return { available: true, keychainAvailable: await bounded(probe.keychainAvailable()).catch(() => false), windows, vault,
      events: probe.events.slice(), overflow: probe.overflow() }
  })
}

export async function stopNativeAuthDiagnostics(application) {
  await application.evaluate(() => globalThis.__mikkaAcceptanceAuthDiagnostics?.restore())
}
