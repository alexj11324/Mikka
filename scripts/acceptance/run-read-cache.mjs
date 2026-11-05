#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { loadEnvironment, assertDeploymentIdentity, EnvironmentError } from '../test-accounts/environment.mjs'
import { runReadCacheAcceptance, publicFailure, ReadCacheAcceptanceError } from './read-cache.mjs'

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
    const result = await runReadCacheAcceptance()
    const summary = { ...result, initialRouteCompileMs, serverStdoutBytes, serverStderrBytes }
    await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
    await writeFile('.cache/e2e/http-acceptance-summary.json', `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    return summary
  } finally {
    await stop(server)
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOwnedReadCacheAcceptance().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(error instanceof EnvironmentError ? { status: 'fail', code: error.code } : publicFailure(error)))
    process.exitCode = 1
  })
}
