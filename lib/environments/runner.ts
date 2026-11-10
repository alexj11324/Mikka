import 'server-only'
import type { Pool } from 'pg'
import { environmentExecutionChanged } from '@/lib/live/lists'
import { withCredentialMasking, type Masker } from '@/lib/secrets/mask'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { registerRunAction, unregisterRunAction } from './active'
import { e2bRunActionBackend, type RunActionBackend } from './backend'
import { EnvironmentRequestError, type RunActionStatus } from './contract'
import { BoundedOutput } from './output'
import {
  finishExecution, flushExecutionOutput, markExecutionStarted,
  readExecutionById, readRunActionExecution, recordExecutionProcess,
} from './runs'

/** How often accumulated output and a cross-instance cancel are written; a
 * timeout-free throttle checked on arrival, never a timer. */
export const OUTPUT_FLUSH_MS = 1_000
/** Slack over the action's own timeout before the runner kills the process. */
const TIMEOUT_GRACE_MS = 15_000

type RunnerInput = {
  database: Pool
  executionId: string
  backend?: RunActionBackend
  masker?: Masker
  now?: () => number
}

/**
 * Runs one queued execution and records its final state. Called from an
 * after-response job, so a slow command never holds the request open. The
 * output is masked before every write; only an invalidation is pushed.
 */
export async function runActionExecution(input: RunnerInput): Promise<void> {
  const row = await readExecutionById(input.database, input.executionId)
  if (!row) return
  if (row.status !== 'queued') return
  if (!await markExecutionStarted(input.database, input.executionId)) return
  await environmentExecutionChanged(input.database, row.runId)

  if (!row.sandboxId) {
    await finishExecution(input.database, row.id, {
      status: 'failed', exitCode: null, errorCode: 'sandbox_unavailable',
      output: { stdout: '', stderr: '', truncated: false },
    })
    await environmentExecutionChanged(input.database, row.runId).catch(() => undefined)
    return
  }

  const masker = input.masker ?? withCredentialMasking(await secretMaskerFor({ workspaceId: row.workspaceId, ownerId: row.ownerId }))
  const output = new BoundedOutput()
  const controller = new AbortController()
  const timeoutSignal = AbortSignal.timeout(row.timeoutSeconds * 1_000 + TIMEOUT_GRACE_MS)
  const signal = AbortSignal.any([controller.signal, timeoutSignal])
  registerRunAction(row.id, controller)

  const now = input.now ?? (() => Date.now())
  let lastFlushAt = 0
  let writes: Promise<void> = Promise.resolve()
  const flush = () => {
    const snapshot = output.snapshot(masker)
    writes = writes.then(async () => {
      // A cancel may arrive on another instance; the row is the shared channel.
      const { rows: [flag] } = await input.database.query<{ cancelled: boolean }>(
        'SELECT "cancelRequestedAt" IS NOT NULL AS cancelled FROM run_action_executions WHERE id=$1', [row.id])
      if (flag?.cancelled && !controller.signal.aborted) controller.abort()
      await flushExecutionOutput(input.database, row.id, snapshot)
      await environmentExecutionChanged(input.database, row.runId)
    }).catch(() => undefined)
  }
  const onOutput = (stream: 'stdout' | 'stderr', text: string) => {
    output.append(stream, text)
    const at = now()
    if (at - lastFlushAt < OUTPUT_FLUSH_MS) return
    lastFlushAt = at
    flush()
  }

  let status: Extract<RunActionStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'> = 'failed'
  let exitCode: number | null = null
  let errorCode: string | null = null
  try {
    const command = await (input.backend ?? e2bRunActionBackend).start({
      workspaceId: row.workspaceId,
      sandboxId: row.sandboxId,
      cwd: row.cwd,
      command: row.command,
      timeoutMs: row.timeoutSeconds * 1_000,
      signal,
      onOutput,
    })
    if (command.pid !== null) await recordExecutionProcess(input.database, row.id, row.sandboxId, command.pid)
    const result = await command.wait()
    await writes
    const final = await readRunActionExecution(input.database, row.runId, row.id)
    const cancelled = Boolean(final?.cancelRequestedAt) || (controller.signal.aborted && !timeoutSignal.aborted)
    const timedOut = result.timedOut || (timeoutSignal.aborted && !controller.signal.aborted)
    exitCode = result.exitCode
    if (cancelled) status = 'cancelled'
    else if (timedOut) { status = 'timed_out'; errorCode = 'timeout' }
    else if (result.exitCode === 0) status = 'succeeded'
    else { status = 'failed'; errorCode = 'exit_code' }
  } catch (error) {
    await writes
    if (controller.signal.aborted) status = 'cancelled'
    else if (timeoutSignal.aborted) { status = 'timed_out'; errorCode = 'timeout' }
    else {
      status = 'failed'
      errorCode = error instanceof EnvironmentRequestError ? error.code : 'sandbox_unavailable'
      // Names only: provider messages may quote a URL or a credential.
      console.warn(JSON.stringify({ msg: 'run_action_failed', executionId: row.id, error: error instanceof Error ? error.name : 'unknown' }))
    }
  } finally {
    unregisterRunAction(row.id, controller)
    const finalOutput = output.snapshot(masker)
    await writes.catch(() => undefined)
    await finishExecution(input.database, row.id, { status, exitCode, errorCode, output: finalOutput })
    await environmentExecutionChanged(input.database, row.runId).catch(() => undefined)
  }
}
