// Isolated macOS acceptance fixture only. Never imported by the daemon or desktop product.
import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.aspectlylabs.mikka.daemon'
const REAL_LAUNCHCTL = '/bin/launchctl'
const LIMIT_BYTES = 8192
const LIMIT_RECORDS = 16
const PROBE_TIMEOUT_MS = 1000
const SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGEMT', 'SIGFPE', 'SIGKILL', 'SIGBUS', 'SIGSEGV', 'SIGSYS', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGURG', 'SIGSTOP', 'SIGTSTP', 'SIGCONT', 'SIGCHLD', 'SIGTTIN', 'SIGTTOU', 'SIGIO', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGINFO', 'SIGUSR1', 'SIGUSR2'])
const STAGES = new Set(['bootout', 'bootstrap', 'probe_service', 'probe_domain', 'unexpected'])
const ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS'])
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const directory = home => join(home, '.mikka/launchctl-fixture-diagnostic')
const fixtureHome = home => process.platform === 'darwin' && process.arch === 'arm64' &&
  typeof home === 'string' && /^\/tmp\/mikka-i-[A-Za-z0-9]+$/.test(home)

function boundedRead(path) {
  const fd = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(LIMIT_BYTES + 1)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    return { text: bytes.subarray(0, Math.min(size, LIMIT_BYTES)).toString('utf8'), oversized: size > LIMIT_BYTES }
  } finally { closeSync(fd) }
}
function marker(home, name) {
  try { writeFileSync(join(directory(home), name), '1\n', { mode: 0o600 }) } catch {}
}
function phase(home) {
  try {
    const value = boundedRead(join(directory(home), 'phase')).text.trim()
    return value === 'install' || value === 'reconnect' ? value : 'unknown'
  } catch { return 'unknown' }
}
function append(home, event) {
  try {
    const file = join(directory(home), 'events.jsonl')
    const previous = boundedRead(file)
    const line = JSON.stringify(event) + '\n'
    if (previous.oversized || previous.text.split('\n').filter(Boolean).length >= LIMIT_RECORDS ||
        Buffer.byteLength(previous.text) + Buffer.byteLength(line) > LIMIT_BYTES) {
      marker(home, 'truncated')
      return
    }
    appendFileSync(file, line, { mode: 0o600 })
  } catch { marker(home, 'write-failed') }
}
function observe(home, stage, args, probe = false) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  // Primary output goes directly to the original inherited pipes. Probe output is discarded.
  const result = spawnSync(REAL_LAUNCHCTL, args, {
    stdio: probe ? 'ignore' : 'inherit',
    ...(probe ? { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' } : {}),
  })
  const errorCode = result.error ? (ERRORS.has(result.error.code) ? result.error.code : 'OTHER') : null
  append(home, {
    stage, phase: phase(home), startedAt, finishedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, Math.round((performance.now() - started) * 1000) / 1000),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: SIGNALS.has(result.signal) ? result.signal : null,
    signalOther: result.signal !== null && !SIGNALS.has(result.signal),
    errorCode, timedOut: errorCode === 'ETIMEDOUT',
  })
  return result
}
function run(home, args) {
  if (!fixtureHome(home)) { process.exitCode = 125; return }
  const domain = 'gui/' + process.getuid()
  const target = domain + '/' + LABEL
  const plist = join(home, 'Library/LaunchAgents', LABEL + '.plist')
  const stage = args.length === 2 && args[0] === 'bootout' && args[1] === target ? 'bootout'
    : args.length === 3 && args[0] === 'bootstrap' && args[1] === domain && args[2] === plist ? 'bootstrap'
    : 'unexpected'
  const result = observe(home, stage, args)
  // Never let a diagnostic write or probe replace the real command's exit result.
  if (result.signal) {
    // Set a failing fallback before re-raising: signal termination must never become success.
    process.exitCode = 1
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.status ?? 127
}
const EVENT_KEYS = ['stage', 'phase', 'startedAt', 'finishedAt', 'elapsedMs', 'exitCode', 'signal', 'signalOther', 'errorCode', 'timedOut'].sort()
function validEvent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(EVENT_KEYS) &&
    STAGES.has(value.stage) && ['install', 'reconnect', 'unknown'].includes(value.phase) &&
    typeof value.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.startedAt) &&
    typeof value.finishedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.finishedAt) &&
    Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 &&
    (value.exitCode === null || (Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)) &&
    (value.signal === null || SIGNALS.has(value.signal)) &&
    typeof value.signalOther === 'boolean' && (value.errorCode === null || value.errorCode === 'OTHER' || ERRORS.has(value.errorCode)) &&
    typeof value.timedOut === 'boolean' && value.timedOut === (value.errorCode === 'ETIMEDOUT')
}
function snapshot(home, installed) {
  const limits = { records: LIMIT_RECORDS, bytes: LIMIT_BYTES, probeTimeoutMs: PROBE_TIMEOUT_MS }
  const result = { status: installed ? 'captured' : 'setup_unavailable', limits,
    truncated: false, writeFailure: false, events: [],
    boundary: 'Completed commands only; a killed wrapper or an unwritable journal may leave missing entries. Probe failures are not proof of absence.' }
  if (!installed) return result
  try {
    for (const [name, key] of [['truncated', 'truncated'], ['write-failed', 'writeFailure']]) {
      try { boundedRead(join(directory(home), name)); result[key] = true } catch {}
    }
    const stored = boundedRead(join(directory(home), 'events.jsonl'))
    if (stored.oversized) { result.status = 'oversized'; result.truncated = true; return result }
    const events = stored.text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (events.length > LIMIT_RECORDS || !events.every(validEvent)) { result.status = 'invalid'; return result }
    result.events = events
    return result
  } catch { result.status = 'unavailable'; return result }
}
export async function prepareLaunchctlDiagnostic(home, node) {
  let installed = false
  let probed = false
  if (fixtureHome(home)) {
    const bin = join(home, '.nvm/versions/node/v22.22.1/bin')
    const wrapper = join(bin, 'launchctl')
    const temporary = wrapper + '.diagnostic-tmp'
    try {
      await mkdir(directory(home), { recursive: true, mode: 0o700 })
      await writeFile(join(directory(home), 'events.jsonl'), '', { mode: 0o600, flag: 'wx' })
      await writeFile(join(directory(home), 'phase'), 'install\n', { mode: 0o600, flag: 'wx' })
      const command = '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(fileURLToPath(import.meta.url)) +
        ' --launchctl-fixture ' + quote(home) + ' "$@"\n'
      await writeFile(temporary, command, { mode: 0o700, flag: 'wx' })
      await chmod(temporary, 0o700)
      await rename(temporary, wrapper)
      installed = true
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return {
    reconnect: async () => {
      if (!installed) return
      try { await writeFile(join(directory(home), 'phase'), 'reconnect\n', { mode: 0o600 }) }
      catch { marker(home, 'write-failed') }
    },
    probeAfterFailure: () => {
      if (!installed || probed) return
      try {
        const captured = snapshot(home, installed)
        const last = captured.events.at(-1)
        if (!last || last.stage !== 'bootstrap' || (last.exitCode === 0 && last.signal === null && !last.signalOther && last.errorCode === null)) return
        probed = true
        const domain = 'gui/' + process.getuid()
        // Outside the original command timeout; always preserve the caller's original error.
        for (const [stage, target] of [['probe_service', domain + '/' + LABEL], ['probe_domain', domain]]) {
          try { observe(home, stage, ['print', target], true) }
          catch { marker(home, 'write-failed') }
        }
      } catch { marker(home, 'write-failed') }
    },
    snapshot: () => snapshot(home, installed),
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--launchctl-fixture') {
  run(process.argv[3], process.argv.slice(4))
}
