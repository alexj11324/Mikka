/** Closed diagnostic receipt from the root-owned runtime maintenance script.
 * This is not a worker log: paths, messages, commands and arbitrary output never
 * become structured error fields or a credential-bearing `cause`. */
export const RUNTIME_REFRESH_CODES = [
  'runtime_identity_mismatch',
  'runtime_install_untrusted',
  'runtime_invalid_json',
  'runtime_io_error',
  'runtime_journal_invalid',
  'runtime_journal_missing',
  'runtime_journal_unreadable',
  'runtime_journal_untrusted',
  'runtime_native_busy',
  'runtime_path_missing',
  'runtime_permission_denied',
  'runtime_pid_unavailable',
  'runtime_pid_untrusted',
  'runtime_process_mismatch',
  'runtime_process_owner_mismatch',
  'runtime_process_predates_switch',
  'runtime_receipt_untrusted',
  'runtime_refresh_conflict',
  'runtime_refresh_invalid',
  'runtime_refresh_refused',
  'runtime_refresh_requires_host',
  'runtime_rollback_mismatch',
  'runtime_rollback_untrusted',
  'runtime_running_pid_unavailable',
  'runtime_running_process_mismatch',
  'runtime_running_source_mismatch',
  'runtime_source_changed',
  'runtime_stage_source_mismatch',
  'runtime_stage_source_unavailable',
  'runtime_stage_untrusted',
  'runtime_staging_conflict',
  'runtime_stop_unconfirmed'
] as const
export const RUNTIME_REFRESH_PHASES = ['arguments', 'installation', 'journal_before_stop', 'stage', 'backup', 'stop_worker', 'journal_after_stop', 'switch_link', 'switch_marker', 'switch_receipt', 'verify_process'] as const
export type RuntimeRefreshCode = typeof RUNTIME_REFRESH_CODES[number]
export type RuntimeGuardPhase = typeof RUNTIME_REFRESH_PHASES[number]
export function isRuntimeRefreshCode(value: unknown): value is RuntimeRefreshCode {
  return typeof value === 'string' && (RUNTIME_REFRESH_CODES as readonly string[]).includes(value)
}
export function isRuntimeGuardPhase(value: unknown): value is RuntimeGuardPhase {
  return typeof value === 'string' && (RUNTIME_REFRESH_PHASES as readonly string[]).includes(value)
}

export class RuntimeRefreshError extends Error {
  readonly name = 'RuntimeRefreshError'
  readonly exitCode = 1
  constructor(readonly code: RuntimeRefreshCode, readonly runtimePhase: RuntimeGuardPhase) {
    super('Worker runtime refresh refused')
  }
}

/** Accept only one bounded exact receipt for this invocation. A provider may
 * put arbitrary, secret-bearing data in stderr or even expose throwing getters;
 * unknown errors keep the existing path and its safe coarse logger. */
export function runtimeRefreshRefusal(error: unknown, action: 'switch' | 'rollback' | 'verify'): RuntimeRefreshError | null {
  try {
    if (!error || typeof error !== 'object') return null
    const { exitCode, stderr } = error as { exitCode?: unknown; stderr?: unknown }
    if (exitCode !== 1 || typeof stderr !== 'string' || stderr.length > 1024) return null
    const value: unknown = JSON.parse(stderr)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(',') !== 'action,code,phase,protocol' || record.protocol !== 'mikka-runtime-refresh-refusal/v1' || record.action !== action ||
      !isRuntimeRefreshCode(record.code) || !isRuntimeGuardPhase(record.phase)) return null
    return new RuntimeRefreshError(record.code, record.phase)
  } catch { return null }
}
