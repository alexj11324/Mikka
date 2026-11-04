// Official app-server 0.163.0 ErrorNotification/TurnError schema. Native
// messages and additionalDetails are intentionally never retained or logged.
const ERROR_CLASSES = [
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded',
  'flexUnavailable', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation',
  'tooManyDenials', 'internalServerError', 'unauthorized', 'badRequest',
  'threadRollbackFailed', 'sandboxError', 'other',
] as const
const HTTP_CLASSES = [
  'httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts',
] as const

type Category = typeof ERROR_CLASSES[number] | typeof HTTP_CLASSES[number] | 'activeTurnNotSteerable' | 'unknown' | 'rpc_refused' | 'cli_exited_early'
export interface CodexFailureInfo { category: Category; httpStatus?: number; rpcCode?: number }
export type CodexFailurePhase = 'error_notification' | 'turn_completed' | 'turn_start' | 'child_exit'

/** Project unknown protocol values onto fixed names and bounded numbers only. */
export function codexFailureInfo(error: unknown): CodexFailureInfo {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const info = value.codexErrorInfo
  for (const category of ERROR_CLASSES) if (info === category) return { category }
  if (info && typeof info === 'object') {
    const active = (info as Record<string, unknown>).activeTurnNotSteerable
    if (active && typeof active === 'object') return { category: 'activeTurnNotSteerable' }
  }
  if (info && typeof info === 'object') for (const category of HTTP_CLASSES) {
    const detail = (info as Record<string, unknown>)[category]
    if (!detail || typeof detail !== 'object') continue
    const status = (detail as Record<string, unknown>).httpStatusCode
    return { category, ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) }
  }
  const code = value.code
  return typeof code === 'number' && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647
    ? { category: 'rpc_refused', rpcCode: code } : { category: 'unknown' }
}

/** Only the classifier's fixed fields may enter the run's owner-facing error. */
export function codexFailureMessage(phase: CodexFailurePhase, info: CodexFailureInfo): string {
  return `Codex subscription execution failed (${phase}: ${info.category}${info.httpStatus === undefined ? '' : `; HTTP ${info.httpStatus}`}${info.rpcCode === undefined ? '' : `; RPC ${info.rpcCode}`})`
}
