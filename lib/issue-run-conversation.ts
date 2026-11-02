/** View helpers for the existing durable run chunk stream; no new session model. */
export function runIsActive(status: string) {
  return ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(status)
}

export function runListRefreshInterval(runs: readonly { status: string }[] | undefined) {
  return runs?.some(run => runIsActive(run.status)) ? 5000 : 0
}

export const RUN_STOP_TIMEOUT_MS = 30_000

/** A persisted request retains its deadline across polling and reloads. */
export function runStopTimeoutRemaining(requestedAt: number, now = Date.now()) {
  return Math.max(0, Math.min(RUN_STOP_TIMEOUT_MS, requestedAt + RUN_STOP_TIMEOUT_MS - now))
}

export function runStatusKey(status: string) {
  switch (status) {
    case 'queued': case 'preparing': case 'running': case 'waiting_input': case 'finishing':
    case 'succeeded': case 'stopped': case 'failed': case 'cancelled': case 'paused': return status
    default: return null
  }
}

/** One line about what a finished run did: the report's summary, else the first line of its error. */
export function runSummaryText(run: { report: unknown; error: string | null }): string | null {
  const report = run.report
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    const summary = (report as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
  }
  return run.error?.split('\n').find(line => line.trim())?.trim() ?? null
}

/**
 * Why a failed run failed, as stored on the run (masked when it was written,
 * PR #804): shown under its start-up stages so the thread says which stage
 * stopped and why. Nothing for a run that did not fail.
 */
export function runFailureText(status: string, error: string | null | undefined): string | null {
  if (status !== 'failed') return null
  const text = error?.trim()
  return text ? text : null
}

/** One start-up stage the daemon reported (`data-run-stage`): which, how long, whether it worked. */
export type ThreadStage = { stage: 'repository' | 'worktree' | 'agent_start'; ms: number; ok: boolean }
const THREAD_STAGES = new Set<ThreadStage['stage']>(['repository', 'worktree', 'agent_start'])

/** One tool call in a folded "N steps" line: its name, the one input that says what it did, and whether it failed. */
export type ThreadStep = { id: string; name: string; detail: string | null; failed: boolean }

const STEP_DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'title', 'description'] as const
const STEP_DETAIL_MAX = 200

function stepDetail(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  let detail: string | null = null
  for (const key of STEP_DETAIL_KEYS) if (typeof record[key] === 'string' && (record[key] as string).trim()) { detail = (record[key] as string).trim(); break }
  if (!detail && Array.isArray(record.files)) detail = record.files.filter(file => typeof file === 'string').join(', ') || null
  if (!detail) return null
  const line = detail.replace(/\s+/g, ' ')
  return line.length > STEP_DETAIL_MAX ? `${line.slice(0, STEP_DETAIL_MAX - 1)}…` : line
}

/**
 * A thread's chunks across its runs (R-81: an ended thread runs again in the same thread). Each run numbers its own
 * text and tool calls, so ids are made per run before they meet in one conversation; one run keeps them as they are.
 */
export function chainChunks<T extends { runId: string; chunk: Record<string, unknown>; at: Date | string }>(rows: readonly T[]): { chunk: Record<string, unknown>; at: T['at'] }[] {
  if (new Set(rows.map(row => row.runId)).size < 2) return rows.map(({ chunk, at }) => ({ chunk, at }))
  return rows.map(({ runId, chunk, at }) => ({
    at,
    chunk: { ...chunk, ...(chunk.id !== undefined ? { id: `${runId}:${String(chunk.id)}` } : {}), ...(chunk.toolCallId !== undefined ? { toolCallId: `${runId}:${String(chunk.toolCallId)}` } : {}) },
  }))
}

export type ThreadItem =
  | { kind: 'agent'; id: string; text: string; at: number }
  | { kind: 'steps'; id: string; count: number; steps: ThreadStep[]; at: number }
  | { kind: 'error'; id: string; text: string; at: number }
  | { kind: 'stages'; id: string; stages: ThreadStage[]; at: number }
  | { kind: 'computer'; id: string; botId: string; runId: string; task: string; at: number }
  | { kind: 'person'; id: string; text: string; author: string; image?: string | null; mine: boolean; at: number }

/**
 * A thread as one conversation: the agent's replies from the durable chunk stream,
 * consecutive tool calls folded into one "N steps" line, and what people said, in time order.
 */
export function threadItems(
  chunks: readonly { chunk: Record<string, unknown>; at: Date | string }[],
  messages: readonly { id: string; text: string; author: string; image?: string | null; mine: boolean; at: Date | string }[],
  expectedRunId?: string,
): ThreadItem[] {
  const items: ThreadItem[] = []
  const texts = new Map<string, Extract<ThreadItem, { kind: 'agent' }>>()
  const calls = new Map<string, ThreadStep>()
  for (const [index, { chunk, at }] of chunks.entries()) {
    const time = new Date(at).getTime()
    const last = items[items.length - 1]
    if (chunk.type === 'text-delta') {
      const id = `text:${String(chunk.id ?? index)}`
      let item = texts.get(id)
      if (!item) { item = { kind: 'agent', id, text: '', at: time }; texts.set(id, item); items.push(item) }
      if (typeof chunk.delta === 'string') item.text += chunk.delta
    } else if (chunk.type === 'tool-input-available') {
      const step: ThreadStep = { id: String(chunk.toolCallId ?? index), name: typeof chunk.toolName === 'string' && chunk.toolName ? chunk.toolName : 'tool', detail: stepDetail(chunk.input), failed: false }
      calls.set(step.id, step)
      if (last?.kind === 'steps') { last.count += 1; last.steps.push(step) }
      else items.push({ kind: 'steps', id: `steps:${index}`, count: 1, steps: [step], at: time })
    } else if (chunk.type === 'tool-output-error' && typeof chunk.toolCallId === 'string') {
      const step = calls.get(chunk.toolCallId)
      if (step) step.failed = true
    } else if (chunk.type === 'data-computer' && expectedRunId && chunk.data && typeof chunk.data === 'object') {
      const data = chunk.data as Record<string, unknown>
      if (data.runId === expectedRunId && typeof data.botId === 'string' && typeof data.task === 'string' && data.task.length <= 200 && !items.some(item => item.kind === 'computer' && item.runId === expectedRunId))
        items.push({ kind: 'computer', id: `computer:${expectedRunId}`, botId: data.botId, runId: expectedRunId, task: data.task, at: time })
    } else if (chunk.type === 'data-run-stage' && chunk.data && typeof chunk.data === 'object') {
      const data = chunk.data as Record<string, unknown>
      if (THREAD_STAGES.has(data.stage as ThreadStage['stage']) && typeof data.ms === 'number' && typeof data.ok === 'boolean') {
        const stage: ThreadStage = { stage: data.stage as ThreadStage['stage'], ms: data.ms, ok: data.ok }
        if (last?.kind === 'stages') last.stages.push(stage)
        else items.push({ kind: 'stages', id: `stages:${index}`, stages: [stage], at: time })
      }
    } else if (chunk.type === 'error' && typeof chunk.errorText === 'string') {
      items.push({ kind: 'error', id: `error:${index}`, text: chunk.errorText, at: time })
    }
  }
  for (const message of messages) items.push({ kind: 'person', id: message.id, text: message.text, author: message.author, image: message.image, mine: message.mine, at: new Date(message.at).getTime() })
  return items.filter(item => item.kind !== 'agent' || item.text.trim()).sort((a, b) => a.at - b.at)
}
