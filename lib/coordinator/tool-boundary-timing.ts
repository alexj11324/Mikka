import { createHash } from 'node:crypto'
import { stepIdentity } from '../model-call-timing'

/** Fixed names and host timestamps only: no query, tool input/output or error text. */
export interface CoordinatorWebSearchTiming {
  msg: 'coordinator_tool_timing'
  tool: 'web_search'
  workflowRunId: string | null
  stepId: string | null
  attempt: number | null
  callRef: string | null
  startedAt: number
  endedAt: number
  outcome: 'ok' | 'unavailable' | 'threw'
}

export interface CoordinatorStopTiming {
  msg: 'coordinator_stop_timing'
  workflowRunId: string | null
  requestedAt: number
  acknowledgedAt: number
  outcome: 'accepted'
}

const runId = (value: unknown) => typeof value === 'string' && /^wrun_[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null
const stepId = (value: unknown) => typeof value === 'string' && /^step_[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null
const callRef = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 180
  ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null

/** Runs inside the existing Node tool step. Terminal metadata lookup happens
 * after the body's wall-clock end, so logging latency cannot inflate its bounds. */
export async function withCoordinatorWebSearchTiming<T extends { ok: boolean }>(
  work: () => Promise<T>, callId?: string, now: () => number = Date.now,
  log: (line: CoordinatorWebSearchTiming) => void = line => console.info(JSON.stringify(line)), identity = stepIdentity,
): Promise<T> {
  const startedAt = now()
  let outcome: CoordinatorWebSearchTiming['outcome'] = 'threw'
  try {
    const result = await work()
    outcome = result.ok ? 'ok' : 'unavailable'
    return result
  } finally {
    const endedAt = now()
    try {
      const step = await identity()
      log({ msg: 'coordinator_tool_timing', tool: 'web_search', workflowRunId: runId(step.workflowRunId),
        stepId: stepId(step.stepId), attempt: typeof step.attempt === 'number' && Number.isSafeInteger(step.attempt) && step.attempt > 0 ? step.attempt : null,
        callRef: callRef(callId), startedAt, endedAt, outcome })
    } catch { /* Diagnostics never mask the original tool result or failure. */ }
  }
}

/** One successful ordinary Stop delivery. Failures keep their original path
 * and are not logged as accepted. No extra query, durable step or retry. */
export async function withCoordinatorStopTiming<T>(
  holder: string, deliver: () => Promise<T>, now: () => number = Date.now,
  log: (line: CoordinatorStopTiming) => void = line => console.info(JSON.stringify(line)),
): Promise<T> {
  const requestedAt = now()
  const result = await deliver()
  const acknowledgedAt = now()
  try { log({ msg: 'coordinator_stop_timing', workflowRunId: runId(holder), requestedAt, acknowledgedAt, outcome: 'accepted' }) }
  catch { /* A successful Stop stays successful if its logger is unavailable. */ }
  return result
}
