import 'server-only'

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, agents } from '@/lib/db/schema'
import { runBotId } from '@/lib/run-bot-name'
import type { BlockRun } from '@/lib/task-blocked'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from './run-failure-projection'

/**
 * Each listed task's newest thread from the last 30 days, as far as 受阻 needs it
 * (lib/task-blocked.ts): the same window and owner as the web's listTaskRuns.
 * One small read beside the task list, which the 任务 list already makes.
 */
export async function newestTaskRuns(userId: string, issueIds: readonly string[]): Promise<(BlockRun & { issueId: string; failureDetails: CompactRunFailure | null; createdAt: Date; botId: string | null })[]> {
  if (!issueIds.length) return []
  // The Bot that dispatched the newest thread (the task list's avatar, 2026-11-07), as the web's listTaskRuns finds it.
  const rows = await db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief, createdAt: agentRuns.createdAt, botId: runBotId })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.issueId, [...issueIds]), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id))
  return rows.map(row => ({ ...row, issueId: row.issueId!, failureDetails: readCompactRunFailure(row.failureDetails) }))
}
