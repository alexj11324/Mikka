/**
 * How long one model call took, as one log line of durations and counts
 * (`model_call_timing`). Never the prompt, the reply or a tool's input: only
 * when the call started, when the first token and the first text came, when
 * it ended, how many input and output tokens it used and how many tools it was
 * offered. Logged for the platform route and for a person's subscription.
 */

export type ModelRoute = 'hosted' | 'subscription'

export interface ModelCallTiming {
  msg: 'model_call_timing'
  route: ModelRoute
  model: string
  workflowRunId: string | null
  stepId: string | null
  attempt: number | null
  tools: number
  /** Resolving the model (route, credentials) before the request was sent. */
  setupMs: number
  /** From the request to the first token of any kind (text, reasoning or a tool call). */
  firstTokenMs: number | null
  /** From the request to the first token of text the person can see. */
  firstTextMs: number | null
  /** From the request to the end of the stream. */
  durationMs: number
  inputTokens: number | null
  /** Input tokens read from the provider's prompt cache. */
  cacheReadTokens: number | null
  /** Input tokens written to the cache (reported by Anthropic routes only). */
  cacheWriteTokens: number | null
  outputTokens: number | null
  toolCalls: number
  finishReason: string | null
  /** The stream failed or was cancelled before it finished. */
  interrupted: boolean
}

export interface ModelCallStart {
  route: ModelRoute
  model: string
  tools: number
  /** When the step began, before the model was resolved. */
  startedAt: number
  /** When the request was sent. */
  requestedAt: number
  workflowRunId?: string | null
  stepId?: string | null
  attempt?: number | null
}

type Part = { type: string; usage?: unknown; finishReason?: unknown }

const FIRST_TOKEN = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-call'])

function total(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && 'total' in value && typeof value.total === 'number') return value.total
  return null
}

function cache(usage: unknown, field: 'cacheRead' | 'cacheWrite'): number | null {
  if (!usage || typeof usage !== 'object' || !('inputTokens' in usage)) return null
  const input = usage.inputTokens
  if (!input || typeof input !== 'object' || !(field in input)) return null
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'number' ? value : null
}

function reason(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'unified' in value && typeof value.unified === 'string') return value.unified
  return null
}

/** Passes the model's stream through unchanged and logs its timing once it ends. Never throws for logging. */
export function timedModelStream<P extends Part, Result extends { stream: ReadableStream<P> }>(result: Result, start: ModelCallStart, now: () => number = Date.now, log: (line: ModelCallTiming) => void = line => console.info(JSON.stringify(line))): Result {
  let firstToken: number | null = null
  let firstText: number | null = null
  let usage: unknown
  let finishReason: string | null = null
  let toolCalls = 0
  let failed = false
  let logged = false
  const emit = (interrupted: boolean) => {
    if (logged) return
    logged = true
    const at = now()
    try {
      log({
        msg: 'model_call_timing', route: start.route, model: start.model,
        workflowRunId: start.workflowRunId ?? null, stepId: start.stepId ?? null, attempt: start.attempt ?? null, tools: start.tools,
        setupMs: start.requestedAt - start.startedAt,
        firstTokenMs: firstToken === null ? null : firstToken - start.requestedAt,
        firstTextMs: firstText === null ? null : firstText - start.requestedAt,
        durationMs: at - start.requestedAt,
        inputTokens: usage && typeof usage === 'object' && 'inputTokens' in usage ? total(usage.inputTokens) : null,
        cacheReadTokens: cache(usage, 'cacheRead'),
        cacheWriteTokens: cache(usage, 'cacheWrite'),
        outputTokens: usage && typeof usage === 'object' && 'outputTokens' in usage ? total(usage.outputTokens) : null,
        toolCalls, finishReason, interrupted,
      })
    } catch { /* timing never fails the call */ }
  }
  const reader = result.stream.getReader()
  const stream = new ReadableStream<P>({
    async pull(controller) {
      let next: ReadableStreamReadResult<P>
      try { next = await reader.read() } catch (error) { emit(true); throw error }
      if (next.done) { emit(failed); controller.close(); return }
      const part = next.value
      if (firstToken === null && FIRST_TOKEN.has(part.type)) firstToken = now()
      if (firstText === null && part.type === 'text-delta') firstText = now()
      if (part.type === 'tool-call') toolCalls++
      if (part.type === 'error') failed = true
      if (part.type === 'finish') { usage = part.usage; finishReason = reason(part.finishReason) }
      controller.enqueue(part)
    },
    async cancel(cause) { emit(true); await reader.cancel(cause) },
  })
  return { ...result, stream } as Result
}

/** The step's own run and attempt, when it runs as a Workflow step; nothing elsewhere. */
export async function stepIdentity(): Promise<Pick<ModelCallStart, 'workflowRunId' | 'stepId' | 'attempt'>> {
  try {
    const { getStepMetadata, getWorkflowMetadata } = await import('workflow')
    const step = getStepMetadata()
    return { workflowRunId: getWorkflowMetadata().workflowRunId, stepId: step.stepId, attempt: step.attempt }
  } catch { return {} }
}
