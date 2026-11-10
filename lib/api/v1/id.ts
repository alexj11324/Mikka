import { createHash } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9._~-]{1,200}$/

/**
 * The `dispatchKey` for a `/api/v1` run. The token and task namespaces keep the
 * existing per-user replay lookup from ever returning another token's or
 * another task's run; only the client key's sha256 is stored. This is the shape
 * the run-creation route uses in the next slice.
 */
export function apiRunDispatchKey(tokenId: string, taskId: string, key: string): string {
  if (!UUID.test(tokenId)) throw new RangeError('apiTokenIdInvalid')
  if (!UUID.test(taskId)) throw new RangeError('apiTaskIdInvalid')
  if (!KEY.test(key)) throw new RangeError('apiIdempotencyKeyInvalid')
  return `api:${tokenId}:${taskId}:${createHash('sha256').update(key).digest('hex')}`
}
