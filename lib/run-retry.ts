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

/** The brief for the retry: the original one, with a note on what happened. */
export function retryPrompt(prompt: string, attempt: number): string {
  const base = prompt.split(`\n\n${RETRY_HEADING}`)[0]
  const note = [
    RETRY_HEADING,
    `This is attempt ${attempt} of ${MAX_RUN_ATTEMPTS}. The previous attempt stopped because its machine went offline, not because of anything it did.`,
    'It may have left work behind: a branch, commits, a pushed branch or an open pull request. Check for them first and continue from there; do not repeat a push, a pull request or a message that already happened.',
  ].join('\n\n')
  return `${base.slice(0, 100_000 - note.length - 2)}\n\n${note}`
}

export type LostRunOutcome =
  | { kind: 'retry'; attempt: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string }

/** What to do with a run whose lease ran out. */
export function lostRunOutcome(run: { attempt: number; stopRequestedAt: Date | null; issueId: string | null; deviceRepoId: string | null }): LostRunOutcome {
  // The person already asked it to stop; losing the machine finished the job.
  if (run.stopRequestedAt) return { kind: 'stopped' }
  if (!run.issueId || !run.deviceRepoId) return { kind: 'failed', error: 'The device went offline, and the run cannot be queued again without its issue and repository.' }
  if (run.attempt >= MAX_RUN_ATTEMPTS) return { kind: 'failed', error: `The device went offline ${run.attempt} times; automatic retries are used up.` }
  return { kind: 'retry', attempt: run.attempt + 1 }
}

/** The error on a retry that waited too long for its device. */
export const DEVICE_STAYED_OFFLINE = 'The device stayed offline, so the retry could not start.'
