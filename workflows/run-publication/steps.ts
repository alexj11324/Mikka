import { RetryableError } from 'workflow'

export async function publishResult(runId: string) {
  'use step'
  const { publishRunResult } = await import('@/lib/run-publications')
  try {
    return await publishRunResult(runId)
  } catch {
    // An interrupted worker may retain the DB lease for two minutes. Do not
    // persist raw database/transport errors in Workflow or expose credentials.
    throw new RetryableError('Run publication is temporarily unavailable.', { retryAfter: '2m' })
  }
}
publishResult.maxRetries = 8

export async function failResult(runId: string) {
  'use step'
  const { failRunPublication } = await import('@/lib/run-publications')
  return failRunPublication(runId)
}
failResult.maxRetries = 8

export async function deliverResult(runId: string) {
  'use step'
  const { publicationDelivery } = await import('@/lib/run-publications')
  const row = await publicationDelivery(runId)
  if (!row) return
  const { processLinearIssueOutbox } = await import('@/lib/linear-sync/worker')
  const { wakeCoordinator } = await import('@/lib/coordinator/wake')
  await processLinearIssueOutbox(row.issueId)
  await wakeCoordinator(row.userId)
}
