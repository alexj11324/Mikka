#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { checkSummary, parseSummary } from '../run-db-tests.mjs'
import { assertDeploymentIdentity, loadEnvironment, EnvironmentError } from './environment.mjs'

// This runner owns its Next child. It never attaches to an existing application
// process or guesses a production/Preview URL. Raw server output is not retained.
async function stop(child) {
  if (!child?.pid) return
  const signal = name => { try { process.kill(-child.pid, name) } catch { /* Already stopped. */ } }
  if (child.exitCode !== null || child.signalCode !== null) { signal('SIGTERM'); return }
  const exited = new Promise(resolve => child.once('exit', resolve))
  signal('SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
  if (!stopped) { signal('SIGKILL'); await exited }
}

function publicTestOutput(output) {
  // TAP assertions can serialize request/response values. Preserve the actual
  // named tests, pass/fail and counts, but never forward arbitrary diagnostics.
  return output.split('\n').filter(line => /^(TAP version \d+|# Subtest: |(?:not )?ok \d+ - |1\.\.\d+|# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) )/.test(line)).join('\n') + '\n'
}

export async function runHttpAcceptance() {
  // This runner terminates child processes and its tests contain destructive
  // cleanup; do not start it until those paths and the CI host are reviewed.
  const retainSafeHttpRunnerAvailable = false
  if (!retainSafeHttpRunnerAvailable) throw new EnvironmentError('HTTP_ACCEPTANCE_RETENTION_BLOCKED')
  const environment = await loadEnvironment()
  const origin = new URL(environment.origin)
  if (origin.protocol !== 'http:') throw new EnvironmentError('HTTP_RUNNER_REQUIRES_HTTP_ORIGIN')
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let server, tests
  let serverExited = false, ready = false
  let serverStdoutBytes = 0, serverStderrBytes = 0
  const started = new Date().toISOString()
  try {
    const next = fileURLToPath(import.meta.resolve('next/dist/bin/next'))
    server = spawn(process.execPath, [next, 'start', '--hostname', origin.hostname.replaceAll(/[[\]]/g, ''), '--port', origin.port || (origin.protocol === 'https:' ? '443' : '80')], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    server.once('error', () => { serverExited = true })
    server.once('exit', () => { serverExited = true })
    server.stdout.on('data', data => { serverStdoutBytes += data.length; if (/Ready in/u.test(data.toString())) ready = true })
    server.stderr.on('data', data => { serverStderrBytes += data.length })
    const deadline = Date.now() + 90_000
    while (!ready) {
      if (serverExited) throw new EnvironmentError('OWNED_HTTP_SERVER_EXITED')
      if (abort.signal.aborted) throw new EnvironmentError('HTTP_ACCEPTANCE_CANCELLED')
      if (Date.now() >= deadline) throw new EnvironmentError('OWNED_HTTP_SERVER_START_TIMEOUT')
      await delay(100)
    }
    if (serverExited) throw new EnvironmentError('OWNED_HTTP_SERVER_EXITED')
    await assertDeploymentIdentity(environment)
    if (abort.signal.aborted) throw new EnvironmentError('HTTP_ACCEPTANCE_CANCELLED')
    tests = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', 'tests/test-account-pool.http.test.mjs'], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    let output = '', overflow = false
    const capture = data => {
      if (output.length + data.length > 4 * 1024 * 1024) { overflow = true; void stop(tests) }
      else output += data.toString()
    }
    tests.stdout.on('data', capture)
    tests.stderr.on('data', capture)
    const status = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { void stop(tests); reject(new EnvironmentError('HTTP_ACCEPTANCE_TIMEOUT')) }, 180_000)
      const cancelTests = () => { void stop(tests); reject(new EnvironmentError('HTTP_ACCEPTANCE_CANCELLED')) }
      abort.signal.addEventListener('abort', cancelTests, { once: true })
      tests.once('error', () => { clearTimeout(timeout); reject(new EnvironmentError('HTTP_TEST_PROCESS_FAILED')) })
      tests.once('exit', code => { clearTimeout(timeout); abort.signal.removeEventListener('abort', cancelTests); resolve(code) })
    })
    process.stdout.write(publicTestOutput(output))
    const totals = parseSummary(output)
    const failure = checkSummary('test-account-http', status, totals)
    await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
    await writeFile('.cache/e2e/http-acceptance-summary.json', `${JSON.stringify({
      environmentId: environment.id, origin: environment.origin, deploymentSha: environment.deploymentSha,
      started, finished: new Date().toISOString(), totals, passed: !failure && !overflow,
      serverStdoutBytes, serverStderrBytes,
    }, null, 2)}\n`, { mode: 0o600 })
    if (failure || overflow) throw new EnvironmentError('HTTP_ACCEPTANCE_FAILED')
    return totals
  } finally {
    await stop(tests)
    await stop(server)
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHttpAcceptance().catch(error => {
    console.error(error instanceof EnvironmentError ? error.code : 'HTTP_ACCEPTANCE_RUNNER_FAILED')
    process.exitCode = 1
  })
}
