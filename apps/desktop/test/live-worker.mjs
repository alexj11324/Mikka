// Miniflare installs synchronous process.exit signal handlers. Keep them in a
// dedicated owned child so the application owner can drain HTTP/Workflow first.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopOwnedApplication } from './production-application.mjs'

const names = new Set(['desktop-acceptance-gateway', 'desktop-docker-gateway'])
const inherited = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
const workerEnvironment = env => Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name)))
const causeNames = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AssertionError', 'MiniflareCoreError'])
const causeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EADDRINUSE', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_RUNTIME_FAILURE'])
const causeEvidence = error => ({ name: causeNames.has(error?.name) ? error.name : 'Error',
  ...(causeCodes.has(error?.code) ? { code: error.code } : {}) })
const validOrigin = value => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && url.origin === value && !url.username && !url.password
  } catch { return false }
}

export async function startLiveWorker({ root, secret, name, signal, forkImpl = fork, startMs = 60_000, graceMs = 35_000 } = {}) {
  assert.ok(names.has(name)); assert.match(secret, /^[a-f0-9]{64}$/)
  root = realpathSync(root)
  const child = forkImpl(fileURLToPath(import.meta.url), ['--worker-child'], {
    cwd: root, env: workerEnvironment(process.env), execArgv: [], detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr?.resume()
  const ready = Promise.withResolvers(), failure = Promise.withResolvers()
  ready.promise.catch(() => {}); failure.promise.catch(() => {})
  let closing, disposed = false, timer
  const kill = (owned, name) => {
    try { process.kill(process.platform === 'win32' ? owned.pid : -owned.pid, name) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  // A catastrophic owner exit still targets only this new detached group.
  const emergency = () => { if (child.pid && child.exitCode === null && child.signalCode === null) kill(child, 'SIGKILL') }
  process.once('exit', emergency)
  const refused = error => { ready.reject(error); failure.reject(error) }
  child.once('error', error => refused(new Error('LIVE_WORKER_PROCESS_FAILED', { cause: error })))
  child.once('exit', (code, exitSignal) => {
    process.removeListener('exit', emergency)
    if (!closing || code !== 0 || exitSignal !== null) refused(new Error('LIVE_WORKER_EXITED'))
  })
  child.on('message', message => {
    if (message?.type === 'ready' && validOrigin(message.origin)) ready.resolve(message.origin)
    else if (message?.type === 'disposed') disposed = true
    else refused(new Error(message?.phase === 'dispose' ? 'LIVE_WORKER_DISPOSE_FAILED' : 'LIVE_WORKER_START_FAILED', { cause: causeEvidence(message?.cause) }))
  })
  function close() {
    if (!closing) closing = (async () => {
      await stopOwnedApplication(child, { graceMs, signal: (owned, requested) => {
        if (requested === 'SIGTERM' && owned.connected) owned.send({ type: 'dispose' }, error => { if (error) refused(new Error('LIVE_WORKER_DISPOSE_SEND_FAILED', { cause: error })) })
        else kill(owned, requested)
      } })
      assert.equal(disposed, true, 'LIVE_WORKER_DISPOSAL_UNPROVEN')
      assert.equal(child.exitCode, 0, 'LIVE_WORKER_EXIT_FAILED')
      assert.equal(child.signalCode, null, 'LIVE_WORKER_SIGNAL_EXIT_FAILED')
    })()
    return closing
  }
  const aborted = () => ready.reject(new Error('LIVE_WORKER_START_ABORTED', { cause: signal?.reason }))
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    child.send({ type: 'start', root, secret, name }, error => { if (error) refused(new Error('LIVE_WORKER_START_SEND_FAILED', { cause: error })) })
    if (signal?.aborted) aborted()
    timer = setTimeout(() => ready.reject(new Error('LIVE_WORKER_START_TIMEOUT')), startMs)
    const origin = await ready.promise
    return { origin, pid: child.pid, close, failure: failure.promise }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'LIVE_WORKER_START_AND_CLEANUP_FAILED') }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', aborted)
  }
}

async function workerChild() {
  assert.ok(process.send && process.connected, 'LIVE_WORKER_PARENT_REQUIRED')
  let worker, starting, closing
  const send = message => { if (process.connected) process.send(message) }
  async function close() {
    if (!closing) closing = (async () => {
      try {
        await starting?.catch(() => {})
        await worker?.dispose()
        send({ type: 'disposed' })
      } catch (error) {
        process.exitCode = 1
        send({ type: 'error', phase: 'dispose', cause: causeEvidence(error) })
      } finally { if (process.connected) process.disconnect() }
    })()
    return closing
  }
  process.on('message', message => {
    if (message?.type === 'dispose') { void close(); return }
    if (message?.type !== 'start' || starting) { send({ type: 'error', phase: 'startup' }); return }
    starting = (async () => {
      assert.ok(names.has(message.name)); assert.match(message.secret, /^[a-f0-9]{64}$/)
      assert.equal(realpathSync(message.root), realpathSync(process.cwd()))
      const require = createRequire(import.meta.url)
      const workerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
      const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire('miniflare')
      const { build } = await import('esbuild')
      const compiled = await build({ entryPoints: [resolve(message.root, 'cloudflare/device-gateway/src/index.ts')], bundle: true,
        format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto'], write: false })
      const options = {
        workers: [{ name: message.name, modules: true, script: compiled.outputFiles[0].text,
          compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
          durableObjects: { DEVICE_SESSION: { className: 'DeviceSession', useSQLite: true } },
          bindings: { GATEWAY_PUSH_SECRET: message.secret } }],
        host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.WARN),
      }
      worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
      send({ type: 'ready', origin: (await worker.ready).origin })
    })()
    void starting.catch(error => { process.exitCode = 1; send({ type: 'error', phase: 'startup', cause: causeEvidence(error) }); void close() })
  })
  process.once('disconnect', () => { void close() })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--worker-child') await workerChild()
