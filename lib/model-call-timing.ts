/**
 * How long one model call took, as one log line of durations and counts
 * (`model_call_timing`). Never the prompt, the reply or a tool's input: only
 * when the call started, when the first token and the first text came, when
 * it ended, how many input and output tokens it used and how many tools it was
 * offered. Logged for the platform route and for a person's subscription.
 */
import type { SubscriptionCallTiming, SubscriptionStages, WorkerTransportTiming, WorkerServiceTier } from '../packages/daemon/src/subscription-worker-timing'

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
  /** Compatible-provider fields before the SDK normalizes an absent read count to zero. */
  rawCache: { read: RawCacheCount; write: RawCacheCount; creation: RawCacheCount }
  outputTokens: number | null
  toolCalls: number
  finishReason: string | null
  /** The stream failed or was cancelled before it finished. */
  interrupted: boolean
  /** Pre-layout tools/system hashes: a difference is a prefix-change candidate, not proof of a miss. Never the content. */
  prefix?: PromptPrefix
  /** Actual Codex layout result; absent for other routes, false for an unchanged prompt. */
  codexLayoutApplied?: boolean
  /** Numeric-only subscription IPC stages; Node offsets and Go durations have separate clocks. */
  subscriptionStages?: SubscriptionStages
}

export type PromptPrefix = { tools: string; system: string[] }
type RawCacheCount = { state: 'number'; tokens: number } | { state: 'missing' | 'null' | 'invalid'; tokens: null }

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
  codexLayoutApplied?: boolean
  subscriptionTiming?: SubscriptionCallTiming
  /** Codex native subscription receipt; kept out of the existing timing logs. */
  observeServiceTier?: true
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
function normalizedModelTokenUsage(usage: unknown): Pick<ModelCallTiming, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> {
  const raw = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  const input = raw.inputTokens && typeof raw.inputTokens === 'object' ? raw.inputTokens as Record<string, unknown> : {}
  const details = raw.inputTokenDetails && typeof raw.inputTokenDetails === 'object' ? raw.inputTokenDetails as Record<string, unknown> : {}
  return {
    inputTokens: total(raw.inputTokens), outputTokens: total(raw.outputTokens),
    cacheReadTokens: modelMetric(input.cacheRead) ?? modelMetric(details.cacheReadTokens),
    cacheWriteTokens: modelMetric(input.cacheWrite) ?? modelMetric(details.cacheWriteTokens),
  }
}

/** Tracing may additionally use the provider's numeric cache-write receipt. */
export function modelTokenUsage(usage: unknown): ReturnType<typeof normalizedModelTokenUsage> {
  const normalized = normalizedModelTokenUsage(usage)
  const details = own(own(usage, 'raw'), 'prompt_tokens_details')
  return { ...normalized, cacheWriteTokens: normalized.cacheWriteTokens
    ?? modelMetric(own(details, 'cache_write_tokens')) ?? modelMetric(own(details, 'cached_creation_tokens')) }
}

function own(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

function rawCache(usage: unknown): ModelCallTiming['rawCache'] {
  const details = own(own(usage, 'raw'), 'prompt_tokens_details')
  const count = (key: 'cached_tokens' | 'cache_write_tokens' | 'cached_creation_tokens'): RawCacheCount => {
    if (!details || typeof details !== 'object' || Array.isArray(details) || !Object.hasOwn(details, key)) return { state: 'missing', tokens: null }
    const value = own(details, key)
    if (value === null) return { state: 'null', tokens: null }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { state: 'number', tokens: value }
    return { state: 'invalid', tokens: null }
  }
  return { read: count('cached_tokens'), write: count('cache_write_tokens'), creation: count('cached_creation_tokens') }
}

export function modelFinishReason(value: unknown): string | null {
  const reason = typeof value === 'string' ? value : value && typeof value === 'object' && 'unified' in value ? value.unified : null
  return typeof reason === 'string' && ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(reason) ? reason : null
}


export type SubscriptionTransportLog = {
  msg: 'subscription_transport_timing'
  workflowRunId: string | null; stepId: string | null; attempt: number | null
  workerOrdinal: number | null; outcome: 'pending' | 'result' | 'error' | 'cancelled' | null
  state: 'reported' | 'missing' | 'invalid'
} & Partial<WorkerTransportTiming>

/** The same trusted step identity; malformed/unbounded input stays unknown. */
const transportIdentity = (value: unknown, prefix: string) => typeof value === 'string' && value.length <= 128 && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value) ? value : null

function logTransport(start: ModelCallStart, log: (line: SubscriptionTransportLog) => void) {
  if (!start.subscriptionTiming) return
  const rows = start.subscriptionTiming.transportSnapshot()
  const identity = { workflowRunId: transportIdentity(start.workflowRunId, 'wrun_'), stepId: transportIdentity(start.stepId, 'step_'),
    attempt: typeof start.attempt === 'number' && Number.isSafeInteger(start.attempt) && start.attempt >= 0 && start.attempt <= 1_000_000 ? start.attempt : null }
  // A cancellation before an execution child has no HTTP evidence.
  if (!rows.length) log({ msg: 'subscription_transport_timing', ...identity, workerOrdinal: null, outcome: null, state: 'missing' })
  for (const row of rows) log({ msg: 'subscription_transport_timing', ...identity, workerOrdinal: row.ordinal, outcome: row.outcome, state: row.state, ...row.timing })
}

export type SubscriptionServiceTierLog = {
  msg: 'subscription_service_tier'
  workflowRunId: string | null; stepId: string | null; attempt: number | null
  workerOrdinal: number | null; outcome: 'pending' | 'result' | 'error' | 'cancelled' | null
  state: 'reported' | 'unavailable' | 'invalid'
} & Partial<WorkerServiceTier>

function logServiceTier(start: ModelCallStart, log: (line: SubscriptionServiceTierLog) => void) {
  if (start.observeServiceTier !== true) return
  const rows = start.subscriptionTiming?.serviceTierSnapshot() ?? []
  const identity = { workflowRunId: transportIdentity(start.workflowRunId, 'wrun_'), stepId: transportIdentity(start.stepId, 'step_'),
    attempt: typeof start.attempt === 'number' && Number.isSafeInteger(start.attempt) && start.attempt >= 0 && start.attempt <= 1_000_000 ? start.attempt : null }
  // An older worker or cancellation without a terminal frame has no receipt.
  if (!rows.length) log({ msg: 'subscription_service_tier', ...identity, workerOrdinal: null, outcome: null, state: 'unavailable' })
  for (const row of rows) log({ msg: 'subscription_service_tier', ...identity, workerOrdinal: row.ordinal, outcome: row.outcome, state: row.state, ...row.serviceTier })
}

/** Passes the model's stream through unchanged and logs its timing once it ends. Never throws for logging. */
export function timedModelStream<P extends Part, Result extends { stream: ReadableStream<P> }>(result: Result, start: ModelCallStart, now: () => number = Date.now, log: (line: ModelCallTiming) => void = line => console.info(JSON.stringify(line)), transportLog: (line: SubscriptionTransportLog) => void = line => console.info(JSON.stringify(line)), serviceTierLog: (line: SubscriptionServiceTierLog) => void = line => console.info(JSON.stringify(line))): Result {
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
        ...normalizedModelTokenUsage(usage),
        rawCache: rawCache(usage),
        toolCalls, finishReason, interrupted,
        ...(start.prefix ? { prefix: start.prefix } : {}),
        ...(start.codexLayoutApplied === undefined ? {} : { codexLayoutApplied: start.codexLayoutApplied }),
        ...(start.subscriptionTiming ? { subscriptionStages: start.subscriptionTiming.snapshot() } : {}),
      })
    } catch { /* timing never fails the call */ }
    try { logTransport(start, transportLog) } catch { /* a diagnostic cannot change a result or cancellation */ }
    try { logServiceTier(start, serviceTierLog) } catch { /* a diagnostic cannot change a result or cancellation */ }
  }
  const reader = result.stream.getReader()
  const stream = new ReadableStream<P>({
    async pull(controller) {
      let next: ReadableStreamReadResult<P>
      try { next = await reader.read() } catch (error) { emit(true); throw error }
      if (next.done) { emit(failed); controller.close(); return }
      const part = next.value
      if (firstToken === null && MODEL_FIRST_TOKEN.has(part.type)) firstToken = now()
      if (firstText === null && part.type === 'text-delta') { firstText = now(); start.subscriptionTiming?.firstSdkText() }
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
