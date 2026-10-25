import type { Pool } from 'pg'
import { CoordinatorInbox, type InboxOptions, type WakeDelivery } from './inbox-receipts'
export type WakeTransport = (owner: string, delivery: WakeDelivery) => Promise<{ runId?: string } | void>
/** Same persisted inbox drives pre-start retries and staged-but-unacknowledged
 * consumer recovery. Transport acknowledgment is never a consumption receipt. */
export async function retryInboxWakes(
  pool: Pool,
  deliver: WakeTransport,
  enabled: boolean,
  limit = 25,
  options: InboxOptions & { onlyOwner?: string } = {},
) {
  if (!enabled) return { attempted: 0, disabled: true }
  const inbox = new CoordinatorInbox(pool, options)
  let attempted = 0,
    deferred = 0,
    exhausted = 0
  for (let scanned = 0; scanned < limit; scanned++) {
    const claim = await inbox.claim(options.onlyOwner)
    if (!claim) break
    if ('exhausted' in claim) {
      exhausted++
      continue
    }
    if ('deferred' in claim) {
      deferred++
      continue
    }
    attempted++
    try {
      const result = await deliver(claim.owner, claim.delivery)
      await inbox.delivered(claim.owner, claim.delivery, result?.runId)
    } catch {
      await inbox.deliveryFailed(claim.owner, claim.delivery)
    }
  }
  return { attempted, disabled: false, deferred, exhausted }
}
