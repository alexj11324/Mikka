/** Fixed diagnostics only. This module is also safe to import in the Workflow VM. */
export const GENERATION_FAILURES = new Set([
  'binding_required', 'account_unavailable', 'binding_mismatch', 'stale_binding',
  'pending_auth', 'reconnect_required', 'disconnected', 'quota_unknown', 'quota_exhausted',
  'provider_approval_required', 'backend_unavailable', 'isolation_required', 'billing_unverified',
  'subscription_rate_limited', 'provider_access_denied', 'provider_request_rejected',
  'provider_temporarily_unavailable', 'provider_route_unavailable',
])
export const BACKEND_FAILURES = new Set(['subscription_timeout', 'subscription_worker_unavailable', 'metadata_unavailable', 'secret_store_unavailable', 'operation_failed'])
export const PRIVATE_FAILURES = new Set(['provider_operation_failed', 'invalid_credential_bundle', 'stale_operation', 'credential_busy', 'secret_create_outcome_unknown', 'secret_not_found', 'credential_integrity_failed', 'subscription_cancelled'])

// AI SDK names contain an underscore: an alphabetic-only check hides them as
// "unknown". An explicit list also prevents arbitrary error names leaking text.
const ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'AbortError', 'TimeoutError',
  'SubscriptionRefusal', 'WorkerRefusal',
  'AI_APICallError', 'AI_EmptyResponseBodyError', 'AI_InvalidArgumentError',
  'AI_InvalidPromptError', 'AI_InvalidResponseDataError', 'AI_JSONParseError',
  'AI_NoContentGeneratedError', 'AI_NoOutputGeneratedError', 'AI_NoObjectGeneratedError',
  'AI_TypeValidationError', 'AI_RetryError', 'AI_InvalidToolInputError',
])
const ERROR_CODES = new Set([
  ...GENERATION_FAILURES, ...BACKEND_FAILURES, ...PRIVATE_FAILURES,
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

type FailureDetails = { errorClass: string; errorCode: string | null; statusCode: number | null }

function field(value: unknown, key: 'name' | 'code' | 'statusCode' | 'cause'): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return (value as Record<string, unknown>)[key] } catch { return undefined }
}

function details(error: unknown): FailureDetails {
  const name = field(error, 'name'), code = field(error, 'code'), status = field(error, 'statusCode')
  return {
    errorClass: typeof name === 'string' && ERROR_CLASSES.has(name) ? name : 'unknown',
    errorCode: typeof code === 'string' && ERROR_CODES.has(code) ? code : null,
    statusCode: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  }
}

/** At most four nodes, including the root. Never reads message, body, headers,
 * data or stack. These observations cannot authorize a retry or change the
 * public refusal: that still requires a typed host refusal in the service. */
export function generationFailureDetails(error: unknown): FailureDetails & { causes: FailureDetails[] } {
  const causes: FailureDetails[] = []
  const seen = new Set<unknown>([error])
  let cause = field(error, 'cause')
  while (cause && typeof cause === 'object' && causes.length < 3 && !seen.has(cause)) {
    seen.add(cause)
    causes.push(details(cause))
    cause = field(cause, 'cause')
  }
  return { ...details(error), causes }
}
