import { runChanged } from '../live/panels'
// What a cloud thread worker printed, visible while it runs and kept after.
//
// The worker starts as an E2B background command. Its output is streamed to
// the server's logs through onStdout/onStderr
// (https://docs.e2b.dev/commands/background.md) and also tee'd into a file in
// the sandbox. The stream only lives as long as the serverless invocation that
// started the worker; anything later is read back from the file
// (https://docs.e2b.dev/filesystem/read-write.md) when the machine is parked,
// fails to provision or ends, and kept with the machine row (logTail).
import type { Pool } from 'pg'
import { runListChanged } from '../live/lists'

type Mask = (text: string) => string

export const WORKER_LOG = '/home/user/.mikka/thread-bootstrap.log'
const DAEMON_LOGS = '/home/user/.mikka/worker/logs'
const LINE_MAX = 500
const LINES_PER_INVOCATION = 500
export const TAIL_MAX = 8000

export type RuntimeRefreshPhase = 'admission' | 'execution_identity' | 'question_machine' | 'question_source' |
  'provider_state' | 'connect' | 'record_sandbox' | 'post_connect_admission' |
  'runtime_configuration' | 'read_worker' | 'verify_worker' | 'install_computer' | 'stage_admission' | 'stage_release' | 'switch_release' |
  'read_refreshed_worker' | 'verify_refreshed_worker' | 'start_desktop' | 'credential_bootstrap' | 'publish_bootstrap' | 'start_worker' | 'worker_register' |
  'verify_runtime' | 'finish' | 'rollback'
const REFRESH_ERROR_CLASSES = new Set(['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'SandboxError',
  'InvalidArgumentError', 'NotEnoughSpaceError', 'NotFoundError', 'FileNotFoundError', 'SandboxNotFoundError',
  'SandboxNotRunningError', 'SandboxUnreachableError', 'AuthenticationError', 'RateLimitError', 'ServiceBusyError',
  'CommandExitError', 'E2BKeyError'])
const REFRESH_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EINVAL', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ABORT_ERR', 'ERR_INVALID_URL', '57014', '55P03', 'e2b_key_missing', 'e2b_key_invalid',
  'e2b_limit_reached', 'e2b_template_unavailable', 'e2b_unavailable'])

/** Maintenance failures must be diagnosable before a worker can register. Only
 * fixed classifications and bounded numbers leave this boundary, never the
 * provider's message, stack, command, output, URL or credential-bearing cause. */
export function logRuntimeRefreshFailure(runId: string, phase: RuntimeRefreshPhase, error: unknown,
  log: (line: string) => void = line => console.warn(line), operation: 'refresh' | 'start' = 'refresh') {
  try {
    const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; exitCode?: unknown; status?: unknown; statusCode?: unknown } : {}
    const name = value.name, code = value.code
    const errorClass = typeof name === 'string' && REFRESH_ERROR_CLASSES.has(name) ? name : 'unknown'
    const errorCode = typeof code === 'string' && REFRESH_ERROR_CODES.has(code) ? code : 'unknown'
    const status = value.status ?? value.statusCode, exitCode = value.exitCode
    log(JSON.stringify({ event: operation === 'start' ? 'thread_runtime_start_failed' : 'thread_runtime_refresh_failed', runId, phase, errorClass, errorCode,
      ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? { exitCode } : {}),
    }))
  } catch { /* Diagnostics cannot replace the original error or prevent lease cleanup/rollback. */ }
}

/** onStdout/onStderr for the worker command: one structured log line per output line, masked and bounded. */
export function workerOutputForwarder(runId: string, mask: Mask, log: (line: string) => void = line => console.info(line)) {
  let sent = 0
  let partial = { stdout: '', stderr: '' }
  const forward = (stream: 'stdout' | 'stderr') => (data: string) => {
    const lines = (partial[stream] + data).split('\n')
    partial = { ...partial, [stream]: lines.pop() ?? '' }
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line) continue
      if (sent === LINES_PER_INVOCATION) log(JSON.stringify({ event: 'thread_worker_output', runId, stream, line: '[further output kept in the sandbox log only]' }))
      if (sent++ >= LINES_PER_INVOCATION) continue
      log(JSON.stringify({ event: 'thread_worker_output', runId, stream, line: mask(line).slice(0, LINE_MAX) }))
    }
  }
  return { onStdout: forward('stdout'), onStderr: forward('stderr') }
}

/** The command that appends the worker's output to its file while still streaming it. */
export function workerCommand(start: string) {
  return `{ ${start}; } 2>&1 | tee -a ${WORKER_LOG}`
}

type TailSandbox = { commands: { run(cmd: string, opts: { user: 'root'; timeoutMs: number }): Promise<{ stdout: string }> } }

/** The last lines of the worker and daemon logs, or null. Never throws, never waits past the timeout. */
export async function readWorkerTail(sandbox: () => Promise<TailSandbox>, timeoutMs = 8000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = (async () => {
    const box = await sandbox()
    const { stdout } = await box.commands.run(
      `tail -n 200 ${WORKER_LOG} 2>/dev/null; for f in ${DAEMON_LOGS}/*; do [ -f "$f" ] && echo "--- $f" && tail -n 200 "$f"; done 2>/dev/null; true`,
      { user: 'root', timeoutMs },
    )
    const text = stdout.trim()
    return text ? text.slice(-TAIL_MAX) : null
  })()
  try {
    return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    read.catch(() => undefined)
  }
}

/**
 * Keeps a tail with the machine (masked with the workspace's secrets). With
 * `asError`, a run that has no error yet also gets it as its error: a
 * provisioning failure says what the worker printed.
 */
export async function saveWorkerTail(query: Pick<Pool, 'query'>, runId: string, tail: string | null, mask: Mask, asError?: string) {
  if (!tail) return
  const masked = mask(tail).slice(-TAIL_MAX)
  await query.query('UPDATE thread_machines SET "logTail"=$2 WHERE "runId"=$1', [runId, masked])
  if (asError) {
    const updated = await query.query('UPDATE agent_runs SET error=$2 WHERE id=$1 AND error IS NULL RETURNING id', [runId, `${asError}\n${masked}`.slice(-TAIL_MAX)])
    if (updated.rowCount) { await runListChanged(query, runId); await runChanged(query, runId) }
  }
}

