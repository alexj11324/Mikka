#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { loadEnvironment, assertDeploymentIdentity, EnvironmentError } from '../test-accounts/environment.mjs'
import { runReadCacheAcceptance, publicFailure, ReadCacheAcceptanceError } from './read-cache.mjs'

const ownedFailures = new WeakMap()
const networkErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR', 'AbortError', 'TimeoutError'])
const processSignals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'])

export function publicOwnedFailure(error) {
  return { ...publicFailure(error), ...ownedFailures.get(error) }
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
        recent = (recent + data.toString()).slice(-2048)
        if (/Ready in/u.test(recent)) { clearTimeout(timeout); resolve() }
      })
      server.stderr.on('data', data => { serverStderrBytes += data.length })
    })
    const preparingAt = Date.now()
    await prepareAttestationRoute(environment)
    const initialRouteCompileMs = Date.now() - preparingAt
    await assertDeploymentIdentity(environment)
    const landingPreparingAt = Date.now()
    await prepareLandingRoute(environment)
    const initialLandingCompileMs = Date.now() - landingPreparingAt
    const result = await runReadCacheAcceptance()
    const summary = { ...result, initialRouteCompileMs, initialLandingCompileMs, serverStdoutBytes, serverStderrBytes }
    await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
    await writeFile('.cache/e2e/http-acceptance-summary.json', `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    return summary
  } catch (error) {
    observedRequests.recordFailure(error, server)
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
