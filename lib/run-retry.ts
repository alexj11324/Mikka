// What happens to a run whose device went offline. The claim and every device
// heartbeat give a run a lease (RUN_LEASE_MS); a run whose lease ran out has
// lost its machine. That is an infrastructure failure, so the run is queued
// again as a new run, up to MAX_RUN_ATTEMPTS in all. A run the agent itself
// ended (error, timeout, a failed verify) is never retried here: running it
// again could repeat its side effects, so it goes to the person.
import { RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS, type RunCheckpoint } from '@mikka/protocol/device'

/** The server upload clock is authoritative for recovery freshness. */
export function checkpointRecoveryError(checkpoint: RunCheckpoint | null, now = new Date()): string | null {
  if (!checkpoint) return null
  if (checkpoint.unavailableReason) return 'Checkpoint exceeds the recovery size limit. Restore the original worktree before retrying.'
  const time = Date.parse(checkpoint.takenAt)
  if (!Number.isFinite(time) || now.getTime() - time > RUN_CHECKPOINT_RECOVERY_MAX_AGE_MS) return 'Checkpoint is older than the thirty-minute recovery window.'
  return null
}

/** Runs a device has claimed and must keep renewing the lease of. */
export const LEASED_RUN_STATUSES = ['preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const

/** First run plus retries. */
export const MAX_RUN_ATTEMPTS = 3

const RETRY_HEADING = '## This run is a retry'

/**
 * What the retry is told. The daemon continues the lost attempt's worktree
 * (and its session, when the harness can resume), so its files are usually
 * still there; a new machine restores only its uploaded repository checkpoint.
 */
export function retryNote(attempt: number): string {
  return [
    RETRY_HEADING,
    `This is attempt ${attempt} of ${MAX_RUN_ATTEMPTS}. The previous attempt stopped because its machine went offline, not because of anything it did.`,
    'Its work is usually still here: check the files and `git status` first and continue from them. Do not repeat a push, a pull request or a message that already happened.',
    'On another device, recovery contains only the uploaded repository snapshot. Ignored files, files outside the repository, secrets, process memory and the old harness session are not transferred. Check the restored files and missing context before taking another external action.',
  ].join('\n\n')
}

/** The brief for the retry: the original one, with the note on what happened. */
export function retryPrompt(prompt: string, attempt: number): string {
  const base = prompt.split(`\n\n${RETRY_HEADING}`)[0]
  const note = retryNote(attempt)
  return `${base.slice(0, 100_000 - note.length - 2)}\n\n${note}`
}

const QUOTA_HEADING = '## This run continues after a usage limit'

/** What a run that goes on after its subscription's quota ran out is told. */
export function quotaContinuationNote(): string {
  return [
    QUOTA_HEADING,
    'The previous run stopped because its subscription\'s usage limit ran out, not because of anything it did.',
    'Its work is usually still here: check the files and `git status` first and continue from them. Do not repeat a push, a pull request or a message that already happened.',
  ].join('\n\n')
}

/** The continuation's brief: the original one, with that note instead of any earlier one. */
export function quotaContinuationPrompt(prompt: string): string {
  const base = prompt.split(`\n\n${RETRY_HEADING}`)[0].split(`\n\n${QUOTA_HEADING}`)[0]
  const note = quotaContinuationNote()
  return `${base.slice(0, 100_000 - note.length - 2)}\n\n${note}`
}

export type LostRunOutcome =
  | { kind: 'retry'; attempt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

/** What to do with a run whose lease ran out. */
export function lostRunOutcome(run: { attempt: number; stopRequestedAt: Date | null; issueId: string | null; deviceRepoId: string | null; questionContinuation?: unknown; status?: string }): LostRunOutcome {
  // The person already asked it to stop; losing the machine finished the job.
  if (run.stopRequestedAt) return { kind: 'stopped' }
  if (run.status === 'paused') return { kind: 'failed', error: 'The device went offline while the run was paused for human control; explicit recovery is required.' }
  // An answer may already have reached its original session. Generic device
  // takeover cannot preserve that guarantee and must never replay the answer.
  if (run.questionContinuation != null) return { kind: 'failed', error: 'The device went offline during an original-session question continuation; explicit recovery is required.' }
  if (!run.issueId || !run.deviceRepoId) return { kind: 'failed', error: 'The device went offline, and the run cannot be queued again without its issue and repository.' }
  if (run.attempt >= MAX_RUN_ATTEMPTS) return { kind: 'failed', error: `The device went offline ${run.attempt} times; automatic retries are used up.` }
  return { kind: 'retry', attempt: run.attempt + 1 }
}

/** The error on a run whose machine went offline when no other machine can continue it. */
export const DEVICE_STAYED_OFFLINE = 'The machine went offline and no other machine can continue the run.'

export { remoteKey } from '@mikka/protocol/repository'

export interface TakeoverCandidate {
  deviceId: string
  harnesses: readonly { harness: string; installed: boolean }[]
}

/**
 * Another machine that can go on with a run whose device went offline: it
 * can clone the repository and has the execution harness installed.
 * Candidates come online, enabled and most recently seen first.
 */
export function pickTakeover(candidates: readonly TakeoverCandidate[], run: { remoteUrl: string | null; harness: string; lostDeviceId: string | null }): TakeoverCandidate | null {
  if (!run.remoteUrl) return null
  return candidates.find(candidate => candidate.deviceId !== run.lostDeviceId
    && candidate.harnesses.some(info => info.harness === run.harness && info.installed)) ?? null
}
