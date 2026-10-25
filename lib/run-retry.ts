// What happens to a run whose device went offline. The claim and every device
// heartbeat give a run a lease (RUN_LEASE_MS); a run whose lease ran out has
// lost its machine. That is an infrastructure failure, so the run is queued
// again as a new run, up to MAX_RUN_ATTEMPTS in all. A run the agent itself
// ended (error, timeout, a failed verify) is never retried here: running it
// again could repeat its side effects, so it goes to the person.

/** Runs a device has claimed and must keep renewing the lease of. */
export const LEASED_RUN_STATUSES = ['preparing', 'running', 'waiting_input', 'finishing'] as const

/** First run plus retries. */
export const MAX_RUN_ATTEMPTS = 3

/**
 * How long a retry may wait in the queue for its offline device before it
 * goes to the person instead.
 */
export const RETRY_QUEUE_WAIT_MS = 30 * 60_000

const RETRY_HEADING = '## This run is a retry'

/**
 * What the retry is told. The daemon continues the lost attempt's worktree
 * (and its session, when the harness can resume), so its files are usually
 * still there; a new machine starts from the base branch instead.
 */
export function retryNote(attempt: number): string {
  return [
    RETRY_HEADING,
    `This is attempt ${attempt} of ${MAX_RUN_ATTEMPTS}. The previous attempt stopped because its machine went offline, not because of anything it did.`,
    'Its work is usually still here: check the files and `git status` first and continue from them. Do not repeat a push, a pull request or a message that already happened.',
  ].join('\n\n')
}

/** The brief for the retry: the original one, with the note on what happened. */
export function retryPrompt(prompt: string, attempt: number): string {
  const base = prompt.split(`\n\n${RETRY_HEADING}`)[0]
  const note = retryNote(attempt)
  return `${base.slice(0, 100_000 - note.length - 2)}\n\n${note}`
}

export type LostRunOutcome =
  | { kind: 'retry'; attempt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

/** What to do with a run whose lease ran out. */
export function lostRunOutcome(run: { attempt: number; stopRequestedAt: Date | null; issueId: string | null; deviceRepoId: string | null; questionContinuation?: unknown }): LostRunOutcome {
  // The person already asked it to stop; losing the machine finished the job.
  if (run.stopRequestedAt) return { kind: 'stopped' }
  // An answer may already have reached its original session. Generic device
  // takeover cannot preserve that guarantee and must never replay the answer.
  if (run.questionContinuation != null) return { kind: 'failed', error: 'The device went offline during an original-session question continuation; explicit recovery is required.' }
  if (!run.issueId || !run.deviceRepoId) return { kind: 'failed', error: 'The device went offline, and the run cannot be queued again without its issue and repository.' }
  if (run.attempt >= MAX_RUN_ATTEMPTS) return { kind: 'failed', error: `The device went offline ${run.attempt} times; automatic retries are used up.` }
  return { kind: 'retry', attempt: run.attempt + 1 }
}

/** The error on a retry that waited too long for its device. */
export const DEVICE_STAYED_OFFLINE = 'The device stayed offline, so the retry could not start.'

/** A git remote as `host/owner/repo`, so https and ssh spellings of one repo match. */
export function remoteKey(url: string): string {
  return url.trim().toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/:\d+\//, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

export interface TakeoverCandidate {
  deviceId: string
  deviceRepoId: string
  remoteUrl: string | null
  harnesses: readonly { harness: string; installed: boolean }[]
}

/**
 * Another machine that can go on with a run whose device went offline: it
 * has the same repository (by remote) and the agent's harness installed.
 * Candidates come online, enabled and most recently seen first.
 */
export function pickTakeover(candidates: readonly TakeoverCandidate[], run: { remoteUrl: string | null; harness: string; lostDeviceId: string | null }): TakeoverCandidate | null {
  if (!run.remoteUrl) return null
  const remote = remoteKey(run.remoteUrl)
  return candidates.find(candidate => candidate.deviceId !== run.lostDeviceId
    && candidate.remoteUrl !== null && remoteKey(candidate.remoteUrl) === remote
    && candidate.harnesses.some(info => info.harness === run.harness && info.installed)) ?? null
}
