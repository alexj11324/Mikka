import 'server-only'

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns } from '@/lib/db/schema'
import type { BlockRun } from '@/lib/task-blocked'

/**
 * Each listed task's newest thread from the last 30 days, as far as 受阻 needs it
 * (lib/task-blocked.ts): the same window and owner as the web's listTaskRuns.
 * One small read beside the task list, which the 任务 list already makes.
 */
export async function newestTaskRuns(userId: string, issueIds: readonly string[]): Promise<(BlockRun & { issueId: string })[]> {
  if (!issueIds.length) return []
  const rows = await db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.issueId, [...issueIds]), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id))
  return rows.map(row => ({ ...row, issueId: row.issueId! }))
}
