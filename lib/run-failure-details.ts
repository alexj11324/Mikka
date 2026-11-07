import { CodedError } from '@mikka/protocol/coded-error'
import { captureRunFailure, readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'
import type { RunCompleteRequest } from '@mikka/protocol/run'
import { APP_BUILD } from './app-build'

/** A completion's diagnostic is host data, separate from the model's report.
 * Normal endings cannot acquire a provider failure from a conflicting payload. */
export function completionFailureDetails(completion: RunCompleteRequest, runId: string,
  context: { status?: string; stopRequested?: boolean; sensitiveText?: readonly string[] } = {}): RunFailure | null {
  const acceptsProviderFailure = !context.stopRequested && ['error', 'timeout', 'device_lost', 'quota_exhausted', 'provider_failure'].includes(completion.stopReason)
    && (!context.status || context.status === 'failed' || context.status === 'paused')
  if (!acceptsProviderFailure) return context.status === 'failed' ? serverRunFailure(runId, new Date()) : null
  const supplied = readRunFailure(completion.failureDetails)
  const code = completion.stopReason === 'timeout' ? 'run_timeout'
    : completion.stopReason === 'quota_exhausted' ? 'run_quota_exceeded' : 'run_failed'
  return captureRunFailure(supplied ? { failureDetails: supplied } : new CodedError(code), {
    runId, appVersion: APP_BUILD || 'unknown', sensitiveText: context.sensitiveText,
  })
}

/** Server terminal transitions have no provider response. Preserve a trusted
 * code, never manufacture diagnostic text from an arbitrary exception message. */
export function serverRunFailure(runId: string, occurredAt: Date, error: CodedError = new CodedError('run_failed')): RunFailure {
  return captureRunFailure(error, { runId, appVersion: APP_BUILD || 'unknown', occurredAt: occurredAt.toISOString() })
}
