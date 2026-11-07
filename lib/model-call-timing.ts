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
  /** Input tokens written to the provider's cache when reported by the receipt. */
  cacheWriteTokens: number | null
  outputTokens: number | null
  toolCalls: number
  finishReason: string | null
  /** The stream failed or was cancelled before it finished. */
  interrupted: boolean
  /** Short hashes of what a provider caches first (tools, then each system message): the one that changes between turns explains a cache miss. Never the content. */
  prefix?: PromptPrefix
}

export type PromptPrefix = { tools: string; system: string[] }

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
  prefix?: PromptPrefix
}

type Part = { type: string; usage?: unknown; finishReason?: unknown }

export const MODEL_FIRST_TOKEN = new Set(['text-delta', 'reasoning-delta', 'tool-input-start', 'tool-input-delta', 'tool-call'])

/** Unknown is not zero. Provider token counts and costs must be finite and nonnegative. */
export function modelMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function total(value: unknown): number | null {
  if (typeof value === 'number') return modelMetric(value)
  if (value && typeof value === 'object' && 'total' in value) return modelMetric(value.total)
  return null
}

/** AI SDK v7 public usage and v4 provider usage both include cache in the input total. */
export function modelTokenUsage(usage: unknown): Pick<ModelCallTiming, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> {
  const raw = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  const input = raw.inputTokens && typeof raw.inputTokens === 'object' ? raw.inputTokens as Record<string, unknown> : {}
  const details = raw.inputTokenDetails && typeof raw.inputTokenDetails === 'object' ? raw.inputTokenDetails as Record<string, unknown> : {}
  // The pinned OpenAI-compatible SDK retains CPA cache writes only in raw usage.
  // Read these two numeric receipt fields; never copy or traverse other raw data.
  const providerUsage = raw.raw && typeof raw.raw === 'object' ? raw.raw as Record<string, unknown> : {}
  const promptDetails = providerUsage.prompt_tokens_details && typeof providerUsage.prompt_tokens_details === 'object' ? providerUsage.prompt_tokens_details as Record<string, unknown> : {}
  return {
    inputTokens: total(raw.inputTokens), outputTokens: total(raw.outputTokens),
    cacheReadTokens: modelMetric(input.cacheRead) ?? modelMetric(details.cacheReadTokens),
    cacheWriteTokens: modelMetric(input.cacheWrite) ?? modelMetric(details.cacheWriteTokens)
      ?? modelMetric(promptDetails.cache_write_tokens) ?? modelMetric(promptDetails.cached_creation_tokens),
  }
}

export function modelFinishReason(value: unknown): string | null {
  const reason = typeof value === 'string' ? value : value && typeof value === 'object' && 'unified' in value ? value.unified : null
  return typeof reason === 'string' && ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(reason) ? reason : null
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
        ...modelTokenUsage(usage),
        toolCalls, finishReason, interrupted,
        ...(start.prefix ? { prefix: start.prefix } : {}),
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
      if (firstToken === null && MODEL_FIRST_TOKEN.has(part.type)) firstToken = now()
      if (firstText === null && part.type === 'text-delta') firstText = now()
      if (part.type === 'tool-call') toolCalls++
      if (part.type === 'error') failed = true
      if (part.type === 'finish') { usage = part.usage; finishReason = modelFinishReason(part.finishReason); failed ||= finishReason === 'error' }
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

const shortHash = async (value: unknown) => (await import('node:crypto')).createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 12)

/** The cacheable prefix of a model call as short hashes: the tools as sent, then each system message's text. */
export async function promptPrefix(prompt: readonly { role: string; content: unknown }[], tools: unknown): Promise<PromptPrefix> {
  return {
    tools: await shortHash(tools ?? null),
    system: await Promise.all(prompt.filter(message => message.role === 'system').map(message => shortHash(message.content))),
  }
}
