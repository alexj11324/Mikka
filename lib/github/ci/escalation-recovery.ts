import 'server-only'
import type { Pool } from 'pg'

/** Retry committed attention events even if their PR was closed or the watch
 * expired. The event itself is the durable queue; no event means no wake. */
export async function retryPendingCiEscalations(options: { pool: Pool; deadline: number; limit?: number; wake?: (userId: string) => Promise<void> }) {
  const limit = Math.max(0, Math.min(20, options.limit ?? 10))
  if (!limit || Date.now() >= options.deadline) return { attempted: 0, failed: 0 }
  const { rows } = await options.pool.query<{ userId: string }>(`WITH due AS (
    SELECT id FROM coordinator_events WHERE "dedupeKey" LIKE 'ci_escalation:%' AND "deliveredAt" IS NULL
      AND ("lastTriageAttemptAt" IS NULL OR "lastTriageAttemptAt" < now()-interval '15 minutes')
    ORDER BY "lastTriageAttemptAt" ASC NULLS FIRST,"createdAt",id FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE coordinator_events e SET "lastTriageAttemptAt"=now() FROM due WHERE e.id=due.id RETURNING e."userId"`, [limit])
  let attempted = 0, failed = 0
  const wake = options.wake ?? (await import('@/lib/coordinator/wake')).wakeCoordinator
  for (const userId of new Set(rows.map(row => row.userId))) {
    if (Date.now() >= options.deadline) break
    attempted++
    try { await wake(userId) } catch { failed++ }
  }
  return { attempted, failed }
}
