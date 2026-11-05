import { RetryableError } from 'workflow'
import type { DueKind } from '@/lib/due-timer'
import type { RecoveryTimerClaim, RecoveryTimerIdentity } from '@/lib/due-timer-owner'

export async function runDue(kind: DueKind) {
  'use step'
  try {
    const { dueJobs } = await import('@/lib/due-timer')
    return await dueJobs[kind].run()
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

export async function handOffDueTimer(kind: DueKind) {
  'use step'
  const { start } = await import('workflow/api')
  const { dueTimer } = await import('./workflow')
  await start(dueTimer, [kind])
}

async function ownerStep<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch {
    // error-cause: SDK errors may carry URLs or private response bodies. The Workflow event log receives only this closed internal failure category.
    throw new RetryableError('due_timer_owner_unavailable', { retryAfter: '1m' })
  }
}

export async function recoveryTimerOwnerDeployment() {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).recoveryTimerDeployment())
}

export async function prepareRecoveryTimerOwner(identity: RecoveryTimerIdentity) {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).prepareRecoveryTimerClaim(identity))
}

export async function retireRecoveryTimerOwner(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim) {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).retirePreviousRecoveryTimer(identity, claim))
}

export async function currentRecoveryTimerOwner(identity: RecoveryTimerIdentity) {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).currentRecoveryTimer(identity))
}

export async function handOffRecoveryTimerOwner(identity: RecoveryTimerIdentity, claim: RecoveryTimerClaim) {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).handOffCurrentRecoveryTimer(identity, claim))
}

export async function redirectRecoveryTimerOwner() {
  'use step'
  return ownerStep(async () => (await import('@/lib/due-timer-owner')).redirectRecoveryTimer())
}
