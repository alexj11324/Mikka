import { sleep } from 'workflow'
import { deliverResult, failResult, publishResult } from './steps'

/** The first retry waits as long as it always did; each later one doubles, up to the cap (#1212). */
export const PUBLICATION_RETRY_FIRST_MS = 30_000
export const PUBLICATION_RETRY_MAX_MS = 10 * 60_000

/** Repeats `attempt` until it reports done: 30 s, 1, 2, 4, 8 min, then every 10 min. A
 * GitHub outage or another worker's two-minute lease rarely clears faster than that. */
export async function untilDone(attempt: () => Promise<{ done: boolean }>) {
  for (let wait = PUBLICATION_RETRY_FIRST_MS; !(await attempt()).done; wait = Math.min(wait * 2, PUBLICATION_RETRY_MAX_MS)) await sleep(wait)
}

/** GitHub retries and duplicate launch leases survive function restarts. */
export async function runPublication(runId: string) {
  'use workflow'
  try {
    await untilDone(() => publishResult(runId))
  } catch {
    await untilDone(() => failResult(runId))
  }
  await deliverResult(runId)
}
