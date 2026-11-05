#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify, stripVTControlCharacters } from 'node:util'
import { loadEnvironment, assertDeploymentIdentity, EnvironmentError } from '../test-accounts/environment.mjs'
import { runReadCacheAcceptance, publicFailure, ReadCacheAcceptanceError } from './read-cache.mjs'

const ownedFailures = new WeakMap()
const networkErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR', 'AbortError', 'TimeoutError'])
const processSignals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'])
const runtimePhases = new Set(['startup', 'attestation-prepare', 'attestation', 'landing-prepare', 'accounts-and-reads', 'evidence'])
const errorClasses = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'EvalError', 'URIError', 'AggregateError', 'ModuleBuildError', 'ModuleNotFoundError', 'ModuleParseError', 'WebpackError'])
const errorCodes = new Set([...networkErrors, 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED', 'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_INVALID_ARG_TYPE', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENOMEM', 'ENOSPC', 'EADDRINUSE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'NEXT_REDIRECT', 'NEXT_NOT_FOUND'])
const errorCategories = [
  ['lockfile_patch', /Failed to patch lockfile|lockfile missing swc dependencies/iu],
  ['module_not_found', /Module not found|Cannot find (?:module|package)|Can't resolve/iu],
  ['missing_export', /Attempted import error|export .* was not found|does not provide an export/iu],
  ['parse_error', /Module parse failed|SyntaxError:|Unexpected token/iu],
  ['client_server_boundary', /server-only|client-only|only works? in Client Components|createContext is not a function/iu],
  ['font_failure', /next\/font.*error|Failed to (?:fetch|download).*font/iu],
  ['loader_failure', /Module build failed|Error in .*loader/iu],
  ['native_binding', /Failed to load SWC|Failed to load native binding/iu],
  ['heap_out_of_memory', /^FATAL ERROR:.*(?:heap limit|heap out of memory|Allocation failed)/iu],
  ['framework_control_flow', /\bNEXT_(?:REDIRECT|NOT_FOUND)\b/u],
]

// Only repository-tracked source names and manifest-declared package names can
// enter an error report. No dependency value, command or environment is retained.
export async function loadOwnedDiagnosticSources({ cwd = process.cwd(), execFileImpl = promisify(execFile), readFileImpl = readFile } = {}) {
  const root = resolve(cwd), files = [], modules = new Set()
  try {
    const { stdout } = await execFileImpl('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 ** 2 })
    const tracked = stdout.split('\0').filter(path => /^[a-zA-Z\d_./@()[\]-]+$/u.test(path) && !path.startsWith('/') && !path.split('/').includes('..'))
    files.push(...tracked.filter(path => /\.(?:[cm]?[jt]sx?|css|scss)$/u.test(path)))
    for (const path of tracked.filter(path => path === 'package.json' || /^packages\/[^/]+\/package\.json$/u.test(path))) {
      try {
        const manifest = JSON.parse(await readFileImpl(resolve(root, path), 'utf8'))
        for (const name of [manifest.name, ...['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(key => Object.keys(manifest[key] ?? {}))]) {
          if (typeof name === 'string' && /^(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/u.test(name)) modules.add(name)
        }
      } catch { /* Missing manifest observations cannot change acceptance. */ }
    }
  } catch { /* Missing git observations leave locations and modules empty. */ }
  return { root, files, modules: [...modules] }
}

function createOwnedErrorObserver({ root = '', files = [], modules = [] } = {}) {
  const knownFiles = new Set(files), knownModules = new Set(modules), records = []
  const active = new Map()
  let phase = 'startup'
  const add = (array, value) => { if (array.length < 8 && !array.some(entry => JSON.stringify(entry) === JSON.stringify(value))) array.push(value) }
  const location = token => {
    let value = token.replace(/^[([]/u, '').replace(/[),;]$/u, '')
    const position = /:(\d+)(?::(\d+))?$/u.exec(value)
    if (position) value = value.slice(0, position.index)
    if (value.startsWith('file://')) value = value.slice(7)
    if (root && value.startsWith(`${root}/`)) value = value.slice(root.length + 1)
    else if (value.startsWith('webpack-internal:///')) value = value.slice('webpack-internal:///'.length).replace(/^\([^/]+\)\//u, '')
    else if (value.startsWith('/')) return null
    value = value.replace(/^\.\//u, '')
    if (!knownFiles.has(value)) return null
    const number = input => input && Number.isSafeInteger(Number(input)) && Number(input) > 0 && Number(input) < 10_000_000 ? Number(input) : null
    return { file: value, line: number(position?.[1]), column: number(position?.[2]) }
  }
  return {
    phase(value) { if (runtimePhases.has(value) && value !== phase) { phase = value; active.clear() } },
    line(stream, value) {
      // Code-frame source strings are data, not diagnostics. Multiline compiler
      // errors and their import traces otherwise continue for at most 40 lines.
      if (/^(?:>\s*)?\d+\s*\|/u.test(value)) return
      const starts = /^⨯\s|^FATAL ERROR:|^(?:Error|TypeError|SyntaxError|ReferenceError|RangeError|AggregateError|ModuleBuildError|ModuleNotFoundError|ModuleParseError|WebpackError)(?:\s*\[[A-Z_]+\])?:/u.test(value)
      if (/^(?:[✓○]\s*)?(?:Ready in|Compiling|Compiled)\b|^(?:GET|POST|HEAD)\s+\S+\s+[1-5]\d{2}\s+in\b/u.test(value)) active.delete(stream)
      let block = active.get(stream)
      if (starts && (/^⨯\s|^FATAL ERROR:/u.test(value) || !block)) {
        if (records.length === 8) { active.delete(stream); return }
        const record = { phase, categories: [], classes: [], codes: [], locations: [], modules: [] }
        records.push(record); block = { record, remaining: 40 }; active.set(stream, block)
      }
      if (!block || block.remaining-- <= 0) { active.delete(stream); return }
      const record = block.record
      for (const [name, pattern] of errorCategories) if (pattern.test(value)) add(record.categories, name)
      for (const token of value.match(/[A-Za-z][A-Za-z_\d]*/gu) ?? []) {
        if (errorClasses.has(token)) add(record.classes, token)
        if (errorCodes.has(token)) add(record.codes, token)
      }
      for (const token of value.match(/[^\s'"`<>]+/gu) ?? []) {
        const source = location(token)
        if (source) add(record.locations, source)
      }
      for (const match of value.matchAll(/(?:Cannot find (?:module|package)|Can't resolve)\s+['"]([^'"]+)['"]|node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/gu)) {
        const target = match[1] ?? match[2], name = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0]
        if (knownModules.has(name)) add(record.modules, name)
      }
    },
    result() { return records.map(record => ({ ...record, categories: record.categories.length ? record.categories : ['unclassified'] })) },
  }
}

export function publicOwnedFailure(error) {
  return { ...publicFailure(error), ...ownedFailures.get(error) }
}

/** Two snapshots and event-driven counters only. /proc reads are confined to
 * the owned CLI's direct children; their PIDs and cgroup path stay private. */
export function createOwnedRuntimeObserver({ readFileImpl = readFile, hardware = () => ({ cpuCount: cpus().length, availableCpuCount: availableParallelism(), systemMemoryBytes: totalmem() }), diagnosticSources } = {}) {
  const counters = { ready: 0, compiling: 0, compiled: 0, httpCompleted: 0, nextError: 0, fatalError: 0, heapOutOfMemory: 0, esbuildDeadlock: 0 }
  const streams = Object.fromEntries(['stdout', 'stderr'].map(name => [name, { decoder: new StringDecoder('utf8'), tail: '' }]))
  const errors = createOwnedErrorObserver(diagnosticSources)
  const number = value => /^\d+$/u.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  const field = (text, name) => number(new RegExp(`^${name}:?\\s+(\\d+)(?:\\s|$)`, 'm').exec(text ?? '')?.[1])
  const bytes = (text, name) => { const value = field(text, name); return value === null ? null : number(value * 1024) }
  const read = async path => { try { return await readFileImpl(path, 'utf8') } catch { return null } }
  let start = null, finishPromise, sealed = false
  const line = (stream, raw) => {
    const value = stripVTControlCharacters(raw).trimStart()
    errors.line(stream, value)
    if (/^(?:✓\s*)?Ready in\b/u.test(value)) counters.ready++
    if (/^(?:○\s*)?Compiling\b/u.test(value)) counters.compiling++
    // Next 16.4 webpack does not emit this on every successful compile.
    // Zero is only the observed marker count, never proof that compilation hung.
    if (/^(?:✓\s*)?Compiled\b/u.test(value)) counters.compiled++
    if (/^(?:GET|POST|HEAD)\s+\S+\s+[1-5]\d{2}\s+in\b/u.test(value)) counters.httpCompleted++
    if (/^⨯\s/u.test(value)) counters.nextError++
    if (value.startsWith('FATAL ERROR:')) counters.fatalError++
    if (/^FATAL ERROR:.*(?:heap limit|heap out of memory|Allocation failed)/iu.test(value)) counters.heapOutOfMemory++
    if (value.startsWith('fatal error: all goroutines are asleep - deadlock!')) counters.esbuildDeadlock++
  }
  const snapshot = async child => {
    const [meminfo, membership, children] = await Promise.all([
      read('/proc/meminfo'), read('/proc/self/cgroup'),
      Number.isSafeInteger(child?.pid) && child.pid > 0 && child.exitCode == null && child.signalCode == null ? read(`/proc/${child.pid}/task/${child.pid}/children`) : null,
    ])
    const member = /^0::(\/[^\r\n\0]*)$/mu.exec(membership ?? '')?.[1]
    const cgroup = member && !member.split('/').some(part => part === '.' || part === '..') ? `/sys/fs/cgroup${member === '/' ? '' : member}` : null
    const [current, maximum, peak, events] = cgroup ? await Promise.all(['memory.current', 'memory.max', 'memory.peak', 'memory.events'].map(file => read(`${cgroup}/${file}`))) : [null, null, null, null]
    const childIds = typeof children === 'string' && /^\s*(?:\d+(?:\s+\d+)*)?\s*$/u.test(children) ? children.trim().split(/\s+/u).filter(Boolean).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0) : null
    const workers = childIds === null ? null : await Promise.all(childIds.slice(0, 8).map(async pid => {
      const status = await read(`/proc/${pid}/status`), parent = field(status, 'PPid')
      const stillDirectChild = parent === null ? null : parent === child.pid
      return { stillDirectChild,
        state: stillDirectChild ? /^State:\s+([RSDZTtXxKWPI])\b/mu.exec(status)?.[1] ?? null : null,
        rssBytes: stillDirectChild ? bytes(status, 'VmRSS') : null,
        peakRssBytes: stillDirectChild ? bytes(status, 'VmHWM') : null }
    }))
    const maxBytes = number(maximum?.trim())
    return { cgroup, childIds, public: {
      systemAvailableBytes: bytes(meminfo, 'MemAvailable'),
      cgroupVersion: cgroup ? 2 : null,
      cgroupCurrentBytes: number(current?.trim()), cgroupMaxBytes: maxBytes,
      cgroupMaxUnlimited: maximum?.trim() === 'max' ? true : maxBytes === null ? null : false,
      cgroupPeakBytes: number(peak?.trim()), cgroupOom: field(events, 'oom'), cgroupOomKill: field(events, 'oom_kill'),
      ownedDirectChildCount: childIds?.length ?? null, workers,
    } }
  }
  return {
    phase(value) {
      // Attribute a partial line to the phase where it arrived, not a later
      // request merely because its newline was buffered by the child.
      for (const [stream, state] of Object.entries(streams)) if (state.tail) { line(stream, state.tail); state.tail = '' }
      errors.phase(value)
    },
    output(stream, data) {
      if (sealed || !Object.hasOwn(streams, stream)) return
      const state = streams[stream], parts = state.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)).split('\n')
      for (let index = 0; index < parts.length; index++) {
        // Retain only a bounded line prefix until newline, never raw log history.
        state.tail = (state.tail + parts[index]).slice(0, 4096)
        if (index < parts.length - 1) { line(stream, state.tail); state.tail = '' }
      }
    },
    async ready(child) {
      // Observability failures are unknown values, not an acceptance bypass or
      // a replacement for the original application/attestation error.
      try { start = await snapshot(child) } catch { start = null }
    },
    finish(child) {
      finishPromise ??= (async () => {
        let end = null, machine = {}
        try { end = await snapshot(child) } catch { /* Unobservable: keep null. */ }
        try { machine = hardware() ?? {} } catch { /* Unobservable: keep null. */ }
        for (const [stream, state] of Object.entries(streams)) { line(stream, (state.tail + state.decoder.end()).slice(0, 4096)); state.tail = '' }
        sealed = true
        const sameCgroup = start?.cgroup && start.cgroup === end?.cgroup
        const delta = (name, monotonic = false) => {
          const first = start?.public[name], last = end?.public[name]
          return !sameCgroup || first == null || last == null || monotonic && last < first ? null : last - first
        }
        return {
          cpuCount: number(machine.cpuCount), availableCpuCount: number(machine.availableCpuCount), systemMemoryBytes: number(machine.systemMemoryBytes),
          output: { ...counters }, errors: errors.result(), start: start?.public ?? null, end: end?.public ?? null,
          retainedDirectChildren: start?.childIds && end?.childIds ? start.childIds.filter(pid => end.childIds.includes(pid)).length : null,
          cgroupCurrentBytesDelta: delta('cgroupCurrentBytes'), cgroupOomDelta: delta('cgroupOom', true), cgroupOomKillDelta: delta('cgroupOomKill', true),
        }
      })()
      return finishPromise
    },
  }
}

// Node 24's bundled Undici publishes {request}, {request,response:{statusCode}}
// and {request,error} on these channels. Observe only this owned origin and
// exact fixed paths: never inspect headers, bodies, query values or messages.
export function observeOwnedRequests(environment, now = () => performance.now()) {
  const base = environment.basePath
  const routes = new Map([
    [`${base}/api/auth/sign-up/email`, 'account-sign-up'], [`${base}/api/auth/sign-in/email`, 'account-sign-in'],
    [`${base}/api/auth/get-session`, 'account-session'], [`${base}/api/workspace`, 'account-workspace'],
    [`${base}/api/conversations/coordinator/read`, 'account-coordinator'], [base, 'account-landing'],
    [`${base}/en`, 'app-page'], [`${base}/api/version`, 'app-version'], [`${base}/api/workspace/switcher`, 'workspace-switcher'],
    [`${base}/api/settings/issue-prefix`, 'settings-issue-prefix'],
  ])
  const pending = new WeakMap(), records = [], subscriptions = []
  const subscribe = (name, listener) => {
    const source = channel(`undici:request:${name}`)
    source.subscribe(listener); subscriptions.push(() => source.unsubscribe(listener))
  }
  subscribe('create', ({ request }) => {
    if (request?.origin !== environment.origin || !['GET', 'POST'].includes(request.method)) return
    const route = routes.get(request.path)
    if (!route) return
    const record = { route, method: request.method, state: 'pending', httpStatus: null, networkError: null, started: now(), elapsedMs: null }
    if (records.length === 32) records.shift()
    records.push(record); pending.set(request, record)
  })
  subscribe('headers', ({ request, response }) => {
    const record = pending.get(request)
    if (!record) return
    if (Number.isInteger(response?.statusCode) && response.statusCode >= 100 && response.statusCode <= 599) record.httpStatus = response.statusCode
    record.state = 'headers-received'
  })
  subscribe('trailers', ({ request }) => {
    const record = pending.get(request)
    if (record) { record.state = 'completed'; record.elapsedMs = Math.max(0, Math.round(now() - record.started)) }
  })
  subscribe('error', ({ request, error }) => {
    const record = pending.get(request)
    if (!record) return
    record.state = 'failed'; record.elapsedMs = Math.max(0, Math.round(now() - record.started)); record.networkError = 'unknown'
    // Transport wrappers can retain a standard network cause. Only a finite
    // code/name set is retained; arbitrary error text never enters evidence.
    for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
      if (networkErrors.has(cause.code)) { record.networkError = cause.code; break }
      if (networkErrors.has(cause.name)) { record.networkError = cause.name; break }
    }
  })
  return {
    recordFailure(error, child) {
      if (!error || !['object', 'function'].includes(typeof error)) return
      const signal = child?.signalCode == null ? null : processSignals.has(child.signalCode) ? child.signalCode : 'other'
      const exitCode = Number.isInteger(child?.exitCode) && child.exitCode >= 0 && child.exitCode <= 255 ? child.exitCode : null
      ownedFailures.set(error, {
        httpRequests: records.map(({ started, elapsedMs, ...record }) => ({ ...record, elapsedMs: elapsedMs ?? Math.max(0, Math.round(now() - started)) })),
        // Snapshot before our finally stops the child, so our SIGTERM cannot
        // be mistaken for the reason the acceptance request failed.
        ownedServerAtFailure: { state: !child?.pid ? 'not-started' : child.exitCode != null || child.signalCode != null ? 'exited' : 'running', exitCode, signal },
      })
    },
    close() { for (const unsubscribe of subscriptions) unsubscribe() },
  }
}

// This runner owns one development server on the attested disposable origin.
// It never attaches to a production process or prints raw application output.
export async function prepareAttestationRoute(environment, fetchImpl = fetch) {
  // Next's Ready event means the listener exists, not that the first route is
  // compiled. One anonymous request prepares that route before the unchanged
  // ten-second HMAC check. No challenge or credential is sent here, so the
  // published route must refuse it; this cannot establish an identity proof.
  let response
  try {
    response = await fetchImpl(`${environment.origin}${environment.basePath}/api/test-environment`, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    })
  } catch (error) { throw new ReadCacheAcceptanceError('owned_attestation_prepare_unavailable', { cause: error }) }
  await response.body?.cancel()
  if (response.status !== 404 || response.headers.has('set-cookie')) throw new ReadCacheAcceptanceError('owned_attestation_prepare_refused')
}

export async function prepareLandingRoute(environment, fetchImpl = fetch) {
  // The observed first authenticated landing timed out at 30,001 ms while
  // next dev was compiling its large page graph. Compile that same route
  // once before leasing accounts; retain the session client's 30-second limit.
  // In development an anonymous page can redirect to the guest-creation API.
  // Never follow it: this request is compilation preparation, not a login.
  let response
  try {
    response = await fetchImpl(`${environment.origin}${environment.basePath}`, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    })
  } catch (error) { throw new ReadCacheAcceptanceError('owned_landing_prepare_unavailable', { cause: error }) }
  await response.body?.cancel()
  // next-intl 4.14.9 syncCookie can set NEXT_LOCALE on an anonymous document.
  // Discard that language preference; refuse every other cookie, including auth.
  if (response.headers.getSetCookie().some(value => !/^NEXT_LOCALE=(?:zh-CN|en)(?:;|$)/u.test(value))) throw new ReadCacheAcceptanceError('owned_landing_prepare_refused')
  const destinations = ['/api/acceptance', `${environment.basePath}/api/acceptance`].flatMap(path => [path, `${environment.origin}${path}`])
  // loading.tsx can make the redirect a 200 streamed document. No document or
  // redirect is executed, and no request to any acceptance endpoint is made.
  if (response.status !== 200 && !(response.status === 307 && destinations.includes(response.headers.get('location')))) throw new ReadCacheAcceptanceError('owned_landing_prepare_refused')
}

async function stop(child) {
  if (!child?.pid) return
  const signal = name => { try { process.kill(-child.pid, name) } catch { /* Already stopped. */ } }
  if (child.exitCode !== null || child.signalCode !== null) { signal('SIGTERM'); return }
  const exited = new Promise(resolve => child.once('exit', resolve))
  signal('SIGTERM')
  if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) {
    signal('SIGKILL'); await exited
  }
}

export async function runOwnedReadCacheAcceptance() {
  const environment = await loadEnvironment()
  const origin = new URL(environment.origin)
  if (origin.protocol !== 'http:') throw new EnvironmentError('HTTP_RUNNER_REQUIRES_HTTP_ORIGIN')
  const observedRequests = observeOwnedRequests(environment)
  const runtime = createOwnedRuntimeObserver({ diagnosticSources: await loadOwnedDiagnosticSources() })
  let server, serverStdoutBytes = 0, serverStderrBytes = 0
  const cancel = () => { void stop(server) }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    const next = fileURLToPath(import.meta.resolve('next/dist/bin/next'))
    server = spawn(process.execPath, [next, 'dev', '--webpack', '--hostname', origin.hostname.replaceAll(/[[\]]/g, ''), '--port', origin.port || '80'], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    await new Promise((resolve, reject) => {
      let recent = ''
      const timeout = setTimeout(() => reject(new EnvironmentError('OWNED_HTTP_SERVER_START_TIMEOUT')), 180_000)
      const failed = () => { clearTimeout(timeout); reject(new EnvironmentError('OWNED_HTTP_SERVER_EXITED')) }
      server.once('error', failed)
      server.once('exit', failed)
      server.stdout.on('data', data => {
        serverStdoutBytes += data.length
        runtime.output('stdout', data)
        recent = (recent + data.toString()).slice(-2048)
        if (/Ready in/u.test(recent)) { clearTimeout(timeout); resolve() }
      })
      server.stderr.on('data', data => { serverStderrBytes += data.length; runtime.output('stderr', data) })
    })
    await runtime.ready(server)
    runtime.phase('attestation-prepare')
    const preparingAt = Date.now()
    await prepareAttestationRoute(environment)
    const initialRouteCompileMs = Date.now() - preparingAt
    runtime.phase('attestation')
    await assertDeploymentIdentity(environment)
    runtime.phase('landing-prepare')
    const landingPreparingAt = Date.now()
    await prepareLandingRoute(environment)
    const initialLandingCompileMs = Date.now() - landingPreparingAt
    runtime.phase('accounts-and-reads')
    const result = await runReadCacheAcceptance()
    runtime.phase('evidence')
    const ownedRuntime = await runtime.finish(server)
    const summary = { ...result, initialRouteCompileMs, initialLandingCompileMs, serverStdoutBytes, serverStderrBytes, ownedRuntime }
    await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
    await writeFile('.cache/e2e/http-acceptance-summary.json', `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    return summary
  } catch (error) {
    observedRequests.recordFailure(error, server)
    const ownedRuntime = await runtime.finish(server)
    if (ownedFailures.has(error)) ownedFailures.set(error, { ...ownedFailures.get(error), ownedRuntime })
    throw error
  } finally {
    observedRequests.close()
    await stop(server)
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOwnedReadCacheAcceptance().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(publicOwnedFailure(error)))
    process.exitCode = 1
  })
}
