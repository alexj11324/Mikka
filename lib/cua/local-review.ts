import { createHash } from 'node:crypto'
import { localComputerRequest, type LocalComputerRequest } from '@mikka/protocol/computer'

/** Hash the same canonical snapshot the daemon displayed locally. Reject changed/extended approvals. */
export function checkedLocalReview(value: unknown, now = Date.now()): LocalComputerRequest {
  const row = localComputerRequest.parse(value)
  if (row.expiresAt <= now || row.expiresAt > now + 300000) throw new Error('Review expired or too far ahead')
  const { id, runId, target, call, expiresAt } = row
  const digest = createHash('sha256').update(JSON.stringify({ id, runId, target, call, expiresAt })).digest('hex')
  if (digest !== row.digest) throw new Error('Review changed')
  return row
}
