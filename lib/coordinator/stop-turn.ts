import 'server-only'
import { and, eq } from 'drizzle-orm'
import { resumeHook } from 'workflow/api'
import { db } from '@/lib/db'
import { coordinatorSessions } from '@/lib/db/schema'
import { coordinatorLeaseActive } from './lease'
import { coordinatorStopToken } from './stop'
import { chatView } from './store'

/** How long 停止 waits for a turn that is about to start (its message is still in the inbox) to take the chat. */
const STARTING_MS = 10_000
const RETRY_MS = 300

/**
 * 停止 in the person's chat with `botId`: aborts the turn working there. A
 * message sent a moment ago may still be waiting for its turn to start; the
 * stop waits for that turn briefly. False when nothing was working.
 */
export async function stopChatTurn(userId: string, botId: string, deadline = Date.now() + STARTING_MS): Promise<boolean> {
  for (;;) {
    const [session] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil })
      .from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
    const holder = coordinatorLeaseActive(session) ? session?.leaseHolder : null
    if (holder?.startsWith('wrun_')) {
      // The hook is registered before the run takes the lease; a run that just ended has none left.
      try { await resumeHook(coordinatorStopToken(holder), {}); return true } catch { /* not listening yet, or over */ }
    } else if (!holder && !(await chatView(userId, 1, botId)).working) return false
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, RETRY_MS))
  }
}
