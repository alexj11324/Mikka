import { sleep } from 'workflow'
import { deliverResult, failResult, publishResult } from './steps'

/** GitHub retries and duplicate launch leases survive function restarts. */
export async function runPublication(runId: string) {
  'use workflow'
  try {
    while (!(await publishResult(runId)).done) await sleep('30s')
  } catch {
    while (!(await failResult(runId)).done) await sleep('30s')
  }
  await deliverResult(runId)
}
