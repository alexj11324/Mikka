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

type Mask = (text: string) => string

export const WORKER_LOG = '/home/user/.mikka/thread-bootstrap.log'
const DAEMON_LOGS = '/home/user/.mikka/worker/logs'
const LINE_MAX = 500
const LINES_PER_INVOCATION = 500
export const TAIL_MAX = 8000

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
  if (asError) await query.query('UPDATE agent_runs SET error=$2 WHERE id=$1 AND error IS NULL', [runId, `${asError}\n${masked}`.slice(-TAIL_MAX)])
}
