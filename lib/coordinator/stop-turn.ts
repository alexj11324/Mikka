import 'server-only'
import { and, eq } from 'drizzle-orm'
import { resumeHook } from 'workflow/api'
import { db, pool } from '@/lib/db'
import { COORDINATOR_LEASE_CHANNEL, nextNotification, openListener } from '@/lib/db/listen'
import { coordinatorSessions } from '@/lib/db/schema'
import { coordinatorLeaseActive } from './lease'
import { coordinatorStopToken } from './stop'
import { chatView } from './store'
import { withCoordinatorStopTiming } from './tool-boundary-timing'
import type { IssueReader } from '@/lib/issue-visibility'
import type { ResourceReference } from '@/lib/resource-access/contract'
import { withResourceAccess } from '@/lib/resource-access/store'

/** How long 停止 waits for a turn that is about to start (its message is still in the inbox) to take the chat. */
const STARTING_MS = 10_000
/** takeInbox NOTIFYs when a turn takes the chat; this re-read only covers a lost notification. */
const STARTING_FALLBACK_MS = 2_500

/**
 * 停止 in the person's chat with `botId`: aborts the turn working there. A
 * message sent a moment ago may still be waiting for its turn to start; the
 * stop waits for that turn briefly, woken by the lease push (#1212) rather
 * than re-reading the session every 300 ms. False when nothing was working.
 */
export async function stopChatTurn(userId: string, botId: string, deadline = Date.now() + STARTING_MS,
  authority?: { reader: IssueReader; reference: ResourceReference }): Promise<boolean> {
  let listener: Awaited<ReturnType<typeof openListener>> | null | undefined
  try {
    for (;;) {
      listener?.consume(botId)
      const [session] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil })
        .from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
      const holder = coordinatorLeaseActive(session) ? session?.leaseHolder : null
      if (holder?.startsWith('wrun_')) {
        // The hook is registered before the run takes the lease; a run that just ended has none left.
        const stop = async () => {
          try { await withCoordinatorStopTiming(holder, () => resumeHook(coordinatorStopToken(holder), {})); return true } catch { return false }
        }
        // Authorization failures propagate. Only an absent/finished hook is
        // retried; the ACL lease covers the mutation, never the waiting loop.
        if (authority ? await withResourceAccess(authority.reader, authority.reference, 'canSteer', stop) : await stop()) return true
      } else if (!holder && !(await chatView(userId, 1, botId, {}, authority?.reader ?? userId)).working) return false
      if (Date.now() >= deadline) return false
      if (listener === undefined) {
        // Listen, then read again at once: a lease taken before LISTEN is seen by that read.
        listener = await openListener(pool, COORDINATOR_LEASE_CHANNEL).catch(() => null)
        continue
      }
      await nextNotification(listener, botId, Math.min(STARTING_FALLBACK_MS, deadline - Date.now()))
    }
  } finally { await listener?.close() }
}
