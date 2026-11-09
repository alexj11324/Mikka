import { AsyncLocalStorage } from 'node:async_hooks'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { stepIdentity } from '@/lib/model-call-timing'
import { withRunSpan } from './tracing/context'

/**
 * How long each part of one dispatch_run took, as one log line (`dispatch_timing`):
 * phase names and milliseconds, and how many GitHub requests it made and how long
 * they took together. Never a repository name, a token, an issue or a note.
 */
export interface DispatchTiming {
  msg: 'dispatch_timing'
  /** Covers dispatchRun from entry, including its initial scope/Profile admission. */
  boundary: 'dispatch_run_entry'
  workflowRunId: string | null
  stepId: string | null
  attempt: number | null
  /** Host wall-clock bounds, so production execution receipts can share the same dispatch origin. */
  startedAt: number
  endedAt: number
  totalMs: number
  /** In the order they ran; a phase that ran twice is listed twice. */
  phases: { phase: string; ms: number }[]
  github: { requests: number; ms: number }
  failed: boolean
}

type Recording = { phases: DispatchTiming['phases']; github: DispatchTiming['github']; refusal?: string }

const current = new AsyncLocalStorage<Recording>()
const repositoryRefusals = new Set(['githubNotConnected', 'githubNotConfigured', 'githubReconnectRequired', 'githubUnavailable', 'githubRepositoryForbidden', 'repositoryNotFound', 'repositoryAmbiguous'])

function markRefusal(code: string) {
  try {
    const span = trace.getActiveSpan()
    span?.setAttributes({ 'error.type': 'DispatchRefusal', 'mikka.error.code': code })
    span?.setStatus({ code: SpanStatusCode.ERROR })
  } catch { /* telemetry never changes a returned refusal */ }
}

/** A closed repository Resolution refusal, recorded before its phase ends. */
export function recordRepositoryRefusal(code: string) {
  if (!repositoryRefusals.has(code)) return
  const recording = current.getStore()
  if (recording) recording.refusal ??= code
  markRefusal(code)
}

/** Times one part of a dispatch; outside a timed dispatch it only runs it. */
export async function timedPhase<T>(phase: string, run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const recording = current.getStore()
  if (!recording) return withRunSpan(`dispatch.${phase}`, {}, run)
  const started = now()
  try { return await withRunSpan(`dispatch.${phase}`, {}, run) } finally { recording.phases.push({ phase, ms: now() - started }) }
}

/** Counts one GitHub request made during a timed dispatch. */
export function noteGitHubRequest(ms: number) {
  const recording = current.getStore()
  if (!recording) return
  recording.github.requests++
  recording.github.ms += ms
}

/** Wrap dispatchRun before any await. Logs once it ends, including refused
 * initial admission; never throws for logging. Older logs without boundary
 * began later in the body and cannot establish the full dispatch duration. */
export async function withDispatchTiming<T>(run: () => Promise<T>, now: () => number = Date.now, log: (line: DispatchTiming) => void = line => console.info(JSON.stringify(line)), identity = stepIdentity): Promise<T> {
  const recording: Recording = { phases: [], github: { requests: 0, ms: 0 } }
  const started = now()
  let failed = true
  try {
    const result = await withRunSpan('dispatch_run', {}, () => current.run(recording, async () => {
      const result = await run()
      if (recording.refusal) markRefusal(recording.refusal)
      return result
    }))
    failed = recording.refusal !== undefined
    return result
  } finally {
    const endedAt = now()
    const totalMs = endedAt - started
    try {
      const step = await identity()
      log({ msg: 'dispatch_timing', boundary: 'dispatch_run_entry', workflowRunId: step.workflowRunId ?? null, stepId: step.stepId ?? null, attempt: step.attempt ?? null, startedAt: started, endedAt, totalMs, phases: recording.phases, github: recording.github, failed })
    } catch { /* timing never fails the dispatch */ }
  }
}
