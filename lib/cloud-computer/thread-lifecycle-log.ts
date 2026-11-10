import { createHash } from 'node:crypto'

const PHASES = new Set(['create_requested', 'created', 'resume_requested', 'resumed', 'restore_requested', 'provisioning', 'active', 'waiting', 'handoff',
  'pause_requested', 'paused', 'pause_failed', 'retire_requested', 'retire_failed', 'retired', 'needs_reconciliation'])
const REASONS = new Set(['created', 'resumed', 'manual_pause', 'manual_end', 'stage_handoff', 'run_ended', 'unclaimed_idle', 'active_run',
  'provisioning', 'retirement', 'retention_elapsed', 'paused_retention', 'checkpoint_unverified', 'native_archive_unverified', 'retirement_guard_refused',
  'creation_cleanup_unconfirmed', 'creation_recovered', 'provider_missing', 'provider_paused', 'execution_budget', 'execution_lease_lost', 'execution_condition_changed', 'task_closed',
  'stop_pending', 'stop_unacknowledged', 'queued_stop', 'quota_wait', 'quota_safe_point_unverified', 'operation_failed'])
const PROVIDERS = new Set(['running', 'paused', 'missing', 'pause_ack', 'kill_ack', 'timeout_renewed', 'unavailable', 'not_observed'])
const COMPUTE_SOURCES = new Set(['database_estimate', 'provider_started_at_estimate', 'unconfirmed_creation_interval'])
const ERROR_KINDS = new Set(['Error', 'AbortError', 'TimeoutError', 'ComputerError', 'CodedError', 'RetryableError', 'SandboxNotFoundError', 'NotFoundError'])
type Identity = { runId: string; issueId?: string | null; sandboxId?: string | null; epoch: number }
type Transition = { phase: unknown; reason?: unknown; deadline?: number | null; provider?: unknown; computeSeconds?: number | string; computeSource?: unknown }
const field = (values: Set<string>, value: unknown, fallback: string) => typeof value === 'string' && values.has(value) ? value : fallback
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null
const hash = (kind: string, value: unknown) => typeof value === 'string' && value.length ? createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 12) : null

/** Same privacy boundary as tracing/sanitize: fixed keys, bounded enums,
 * numeric measurements, and stable hashes instead of raw user/provider data. */
export function threadLifecycleLogFields(identity: Identity, transition: Transition) {
  return {
    run: hash('run', identity.runId), task: hash('task', identity.issueId), vm: hash('vm', identity.sandboxId),
    epoch: Number.isSafeInteger(identity.epoch) ? finite(identity.epoch) : null,
    phase: field(PHASES, transition.phase, 'needs_reconciliation'), reason: field(REASONS, transition.reason, 'unknown'),
    owner: 'run-recovery', deadline: finite(transition.deadline),
    computeSeconds: finite(Number(transition.computeSeconds)), computeSource: field(COMPUTE_SOURCES, transition.computeSource, 'database_estimate'),
    provider: field(PROVIDERS, transition.provider, 'not_observed'),
    observedAt: Date.now(),
  }
}

/** Call only after the state write has committed, and only for a transition. */
export function logThreadLifecycle(identity: Identity, transition: Transition) {
  console.info('thread_machine_lifecycle', threadLifecycleLogFields(identity, transition))
}

export const threadLifecycleErrorKind = (error: unknown) => field(ERROR_KINDS, error instanceof Error ? error.name : undefined, 'UnknownError')
