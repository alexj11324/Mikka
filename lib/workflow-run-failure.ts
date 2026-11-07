import { APICallError, type LanguageModel } from 'ai'
import { GatewayError } from '@ai-sdk/gateway'
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde'
import { captureRunFailure, runFailureSchema, RunFailureError, type RunFailure, type RunFailureContext } from '@mikka/protocol/run-failure'
import { GENERATION_FAILURES } from './subscription-generation-diagnostics'
import { HOSTED_STATES } from './billing/hosted-usage'

const LEGACY_CODES = new Set([...GENERATION_FAILURES, ...HOSTED_STATES.filter(code => code !== 'ready'), 'subscription_generation_failed', 'subscription_model_unavailable'])

/** The Workflow SDK's generic Error codec drops custom fields and preserves a
 * raw cause. This explicit codec persists only the already-redacted record.
 * The in-memory error still retains its original cause for host diagnostics. */
export class WorkflowRunFailureError extends RunFailureError {
  readonly legacyCode?: string
  constructor(failure: RunFailure, options: { cause?: unknown } = {}, legacyCode?: string) {
    super(failure, options)
    if (legacyCode && LEGACY_CODES.has(legacyCode)) { this.legacyCode = legacyCode; this.message = legacyCode }
  }
  static [WORKFLOW_SERIALIZE](value: WorkflowRunFailureError) {
    return { failureDetails: value.failureDetails, ...(value.legacyCode ? { legacyCode: value.legacyCode } : {}) }
  }
  static [WORKFLOW_DESERIALIZE](value: { failureDetails: unknown; legacyCode?: string }) {
    return new WorkflowRunFailureError(runFailureSchema.parse(value.failureDetails), {}, value.legacyCode)
  }
}

/** Keep cancellation recognizable by the SDK, without persisting the caller's
 * arbitrary abort reason or classifying it as a failed provider operation. */
export class WorkflowAbortError extends Error {
  constructor(options: { cause?: unknown } = {}) { super('subscription_cancelled', options); this.name = 'AbortError' }
  static [WORKFLOW_SERIALIZE](_value: WorkflowAbortError) { return {} }
  static [WORKFLOW_DESERIALIZE](_value: unknown) { return new WorkflowAbortError() }
}

type RetryMetadata = { isRetryable: boolean; statusCode?: number; responseHeaders?: Record<string, string> }
function retryHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const safe: Record<string, string> = {}
  for (const key of ['retry-after-ms', 'retry-after']) {
    const value = headers?.[key]
    if (typeof value !== 'string') continue
    const number = Number.parseFloat(value)
    if (!Number.isNaN(number)) safe[key] = String(number)
    else if (key === 'retry-after' && Number.isFinite(Date.parse(value))) safe[key] = new Date(value).toUTCString()
  }
  return Object.keys(safe).length ? safe : undefined
}

/** The SDK retries only branded API/Gateway errors. Preserve that decision and
 * its two delay headers while excluding request/body/URL/general headers from
 * the durable representation. Gateway and API errors share this SDK contract. */
export class WorkflowProviderFailureError extends APICallError {
  readonly failureDetails: RunFailure
  readonly code: RunFailure['code']
  constructor(failure: RunFailure, retry: RetryMetadata, options: { cause?: unknown } = {}) {
    const safe = runFailureSchema.parse(failure)
    super({ message: safe.code, url: '', requestBodyValues: undefined, cause: options.cause,
      isRetryable: retry.isRetryable === true, statusCode: typeof retry.statusCode === 'number' && Number.isInteger(retry.statusCode) && retry.statusCode >= 100 && retry.statusCode <= 599 ? retry.statusCode : undefined,
      responseHeaders: retryHeaders(retry.responseHeaders) })
    this.failureDetails = safe; this.code = safe.code
  }
  static [WORKFLOW_SERIALIZE](value: WorkflowProviderFailureError) {
    return { failureDetails: value.failureDetails, isRetryable: value.isRetryable, statusCode: value.statusCode, responseHeaders: value.responseHeaders }
  }
  static [WORKFLOW_DESERIALIZE](value: RetryMetadata & { failureDetails: unknown }) {
    return new WorkflowProviderFailureError(runFailureSchema.parse(value.failureDetails), value)
  }
}

function durableFailure(error: unknown, context: RunFailureContext) {
  if (error instanceof Error && error.name === 'AbortError') return new WorkflowAbortError({ cause: error })
  if (APICallError.isInstance(error) || GatewayError.isInstance(error)) {
    const headers = APICallError.isInstance(error) ? error.responseHeaders : APICallError.isInstance(error.cause) ? error.cause.responseHeaders : undefined
    return new WorkflowProviderFailureError(captureRunFailure(error, context), { isRetryable: error.isRetryable, statusCode: error.statusCode, responseHeaders: headers }, { cause: error })
  }
  const legacy = error instanceof WorkflowRunFailureError ? error.legacyCode : error instanceof Error && LEGACY_CODES.has(error.message) ? error.message : undefined
  return new WorkflowRunFailureError(captureRunFailure(error, context), { cause: error }, legacy)
}

export async function workflowFailureCall<T>(start: () => Promise<T>, context: RunFailureContext): Promise<T> {
  try { return await start() } catch (error) { throw durableFailure(error, context) }
}

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type StreamResult = Awaited<ReturnType<Model['doStream']>>

/** Captures every provider failure while still in the Node model step, before
 * stream parts cross durable serialization. Success/cancellation stay on the
 * same stream and there are no additional requests or retries. */
export async function workflowFailureStream(start: () => Promise<StreamResult>, context: RunFailureContext): Promise<StreamResult> {
  const result = await workflowFailureCall(start, context)
  const reader = result.stream.getReader()
  let closed = false
  const stream: StreamResult['stream'] = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (closed) return
        if (done) { closed = true; reader.releaseLock(); controller.close(); return }
        controller.enqueue(value.type === 'error' ? { ...value, error: durableFailure(value.error, context) } : value)
      } catch (error) {
        if (closed) return
        closed = true; reader.releaseLock(); controller.error(durableFailure(error, context))
      }
    },
    async cancel(reason) { closed = true; try { await reader.cancel(reason) } finally { reader.releaseLock() } },
  })
  return { ...result, stream }
}
