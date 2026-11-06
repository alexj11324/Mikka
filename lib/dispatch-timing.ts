import { AsyncLocalStorage } from 'node:async_hooks'
import { stepIdentity } from '@/lib/model-call-timing'
import { withRunSpan } from './tracing/context'

/**
 * How long each part of one dispatch_run took, as one log line (`dispatch_timing`):
 * phase names and milliseconds, and how many GitHub requests it made and how long
 * they took together. Never a repository name, a token, an issue or a note.
 */
export interface DispatchTiming {
  msg: 'dispatch_timing'
  workflowRunId: string | null
  stepId: string | null
  attempt: number | null
  totalMs: number
  /** In the order they ran; a phase that ran twice is listed twice. */
  phases: { phase: string; ms: number }[]
  github: { requests: number; ms: number }
  failed: boolean
}

type Recording = { phases: DispatchTiming['phases']; github: DispatchTiming['github'] }

const current = new AsyncLocalStorage<Recording>()

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

/** Runs one dispatch and logs its timing once it ends. Never throws for logging. */
export async function withDispatchTiming<T>(run: () => Promise<T>, now: () => number = Date.now, log: (line: DispatchTiming) => void = line => console.info(JSON.stringify(line)), identity = stepIdentity): Promise<T> {
  const recording: Recording = { phases: [], github: { requests: 0, ms: 0 } }
  const started = now()
  let failed = true
  try {
    const result = await withRunSpan('dispatch_run', {}, () => current.run(recording, run))
    failed = false
    return result
  } finally {
    const totalMs = now() - started
    try {
      const step = await identity()
      log({ msg: 'dispatch_timing', workflowRunId: step.workflowRunId ?? null, stepId: step.stepId ?? null, attempt: step.attempt ?? null, totalMs, phases: recording.phases, github: recording.github, failed })
    } catch { /* timing never fails the dispatch */ }
  }
}
