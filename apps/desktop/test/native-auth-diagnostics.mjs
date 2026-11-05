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

/** Test inspector only; observes the actual transport without changing any
 * request/response. Stop before further UI work. Publish only on failure. */
export async function startNativeAuthDiagnostics(application, expected) {
  const result = await application.evaluate(({ app, BrowserWindow, session }, input) => {
    if (app.getPath('userData') !== input.expected.profile || globalThis.__mikkaAcceptanceAuthDiagnostics) return { started: false }
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) return { started: false }
    const fs = process.getBuiltinModule('node:fs')
    const path = process.getBuiltinModule('node:path')
    const backend = session.fromPartition('persist:mikka-dev-bundled-backend')
    const originalFetch = backend.fetch
    const originalSend = window.webContents.send
    const events = []
    let overflow = false
    const classify = value => {
      try {
        const pathname = new URL(value).pathname
        return input.routes.find(([pattern]) => new RegExp(pattern).test(pathname))?.[1] ?? 'other'
      } catch { return 'other' }
    }
    const add = value => {
      if (events.length < 200) events.push({ at: Date.now(), ...value })
      else overflow = true
    }
    backend.fetch = async function (request, init) {
      const route = classify(typeof request === 'string' ? request : request.url)
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(init?.method ?? 'GET') ? (init?.method ?? 'GET') : 'other'
      try {
        const response = await originalFetch.call(this, request, init)
        add({ source: 'main-fetch', route, method, status: response.status })
        return response
      } catch (error) {
        add({ source: 'main-fetch', route, method, status: 0 })
        throw error
      }
    }
    const file = path.join(input.expected.profile, 'credentials', 'desktop-session.bin')
    window.webContents.send = function (channel, ...args) {
      if (channel === 'bundled:session-changed') add({ source: 'session-change', vaultExists: fs.existsSync(file) })
      return originalSend.call(this, channel, ...args)
    }
    globalThis.__mikkaAcceptanceAuthDiagnostics = {
      expected: input.expected, events, file, classify,
      overflow: () => overflow,
      restore() {
        backend.fetch = originalFetch
        window.webContents.send = originalSend
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
    return { available: true, keychainAvailable: await bounded(safeStorage.isAsyncEncryptionAvailable()).catch(() => false), windows, vault,
      events: probe.events.slice(), overflow: probe.overflow() }
  })
}

export async function stopNativeAuthDiagnostics(application) {
  await application.evaluate(() => globalThis.__mikkaAcceptanceAuthDiagnostics?.restore())
}
