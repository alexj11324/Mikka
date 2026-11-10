import { createHash } from 'node:crypto'

/** Bump when chatItems changes persisted display semantics. Both the known
 * version and continuation proofs must reject the earlier cached projection. */
export const COORDINATOR_CHAT_PROJECTION_VERSION = 3

/** Keep the existing 32-hex wire shape while binding opaque database hashes
 * (or the version's aggregate input) to the same chat projection contract. */
export function chatProjectionHash(value: string): string {
  return createHash('sha256').update(`coordinator-chat:${COORDINATOR_CHAT_PROJECTION_VERSION}|${value}`).digest('hex').slice(0, 32)
}
