import { withRecoveryWorkflowAuthority } from '@/lib/enterprise/execution-authority'
import { RetryableError } from 'workflow'
import type { DueKind } from '@/lib/due-timer'
import type { RecoveryTimerClaim, RecoveryTimerIdentity } from '@/lib/due-timer-owner'

export async function runDue(kind: DueKind) {
  'use step'
  try {
    const { dueJobs } = await import('@/lib/due-timer')
    return await (kind === 'run-recovery' ? withRecoveryWorkflowAuthority(() => dueJobs[kind].run()) : dueJobs[kind].run())
  } catch {
    // error-cause: the Workflow event log would persist raw database text; each job's sweep is idempotent.
    throw new RetryableError('due_timer_unavailable', { retryAfter: '1m' })
  }
}
runDue.maxRetries = 5

export async function nextDue(kind: DueKind) {
  'use step'
  const { dueJobs } = await import('@/lib/due-timer')
  return dueJobs[kind].next()
}

/** Starts the successor on the latest deployment: from a step, start() would otherwise pin it to this run's (#1410). */
export async function handOffDueTimer(kind: DueKind) {
  'use step'
  const { start } = await import('workflow/api')
  const { dueTimer } = await import('./workflow')
  await start(dueTimer, [kind], { deploymentId: 'latest' })
}

async function ownerStep<T>(phase: 'deployment' | 'prepare' | 'retire' | 'current' | 'handoff' | 'redirect', work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    const { CodedError, logCodedError } = await import('@mikka/protocol/coded-error')
    if (!(error instanceof CodedError && error.code === 'due_timer_owner_unavailable')) {
      logCodedError(new CodedError('due_timer_owner_unavailable', { detail: 'sdk_operation_failed', cause: error }), { kind: 'run-recovery', phase })
    }
    // error-cause: the original cause is logged by name/code above; the persisted Workflow error must not contain raw SDK messages, URLs or response bodies.
    throw new RetryableError('due_timer_owner_unavailable', { retryAfter: '1m' })
  }
}

export async function recoveryTimerOwnerDeployment() {
  'use step'
  return ownerStep('deployment', async () => (await import('@/lib/due-timer-owner')).recoveryTimerDeployment())
}

export async function prepareRecoveryTimerOwner(identity: RecoveryTimerIdentity) {
  'use step'
  return ownerStep('prepare', async () => (await import('@/lib/due-timer-owner')).prepareRecoveryTimerClaim(identity))
}

export async function retireRecoveryTimerOwner(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim) {
  'use step'
  return ownerStep('retire', async () => (await import('@/lib/due-timer-owner')).retirePreviousRecoveryTimer(identity, claim))
}

export async function currentRecoveryTimerOwner(identity: RecoveryTimerIdentity) {
  'use step'
  return ownerStep('current', async () => (await import('@/lib/due-timer-owner')).currentRecoveryTimer(identity))
}

export async function handOffRecoveryTimerOwner(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim) {
  'use step'
  return ownerStep('handoff', async () => (await import('@/lib/due-timer-owner')).handOffCurrentRecoveryTimer(identity, claim))
}

export async function redirectRecoveryTimerOwner() {
  'use step'
  return ownerStep('redirect', async () => (await import('@/lib/due-timer-owner')).redirectRecoveryTimer())
}
