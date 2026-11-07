import 'server-only'

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, agents, bots, issues } from '@/lib/db/schema'
import { runBotId } from '@/lib/run-bot-name'
import type { ThreadOutcome } from '@/lib/thread-groups'
import type { MobileTaskBot, MobileTaskSchedule } from '@/lib/mobile-task-view'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from './run-failure-projection'

/**
 * Each listed task's newest thread from the last 30 days, as far as 受阻 needs it
 * (lib/task-blocked.ts): the same window and owner as the web's listTaskRuns.
 * One small read beside the task list, which the 任务 list already makes.
 */
export type TaskRunSnapshot = { issueId: string; runId: string | null; status: string | null; outcome: ThreadOutcome | null; failureDetails: CompactRunFailure | null; bot: MobileTaskBot | null; schedule: MobileTaskSchedule | null }

/** Schedule definitions explicitly linked to this task. Never attach every schedule of its Bot. */
export function taskSchedule(issueId: typeof issues.id, userId: string, workspaceId?: string) {
  return sql<MobileTaskSchedule | null>`(select jsonb_build_object('label', s.definition->>'title', 'nextAt', s.next_at)
    from user_schedules s where s.owner_id=${userId} and s.definition->'task'->>'kind'='issue_snapshot'
      and s.definition->'task'->>'issueId'=${issueId}::text and s.status in ('active','paused')
      ${workspaceId ? sql`and s.workspace_id=${workspaceId}::uuid` : sql``}
    order by s.next_at asc nulls last, s.id limit 1)`
}

export async function newestTaskRuns(userId: string, issueIds: readonly string[], workspaceId?: string): Promise<TaskRunSnapshot[]> {
  if (!issueIds.length) return []
  const latest = db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'), botId: runBotId.as('botId') })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.issueId, [...issueIds]), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).as('newest_task_runs')
  // Start from the authorized tasks so a scheduled task without a thread is decorated too.
  // Both decorations share the existing read, including closed tasks' Bot avatars.
  const rows = await db.select({ issueId: issues.id, runId: latest.runId, status: latest.status, outcome: latest.outcome, failureDetails: latest.failureDetails,
    bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }, schedule: taskSchedule(issues.id, userId, workspaceId),
  }).from(issues).leftJoin(latest, eq(latest.issueId, issues.id))
    .leftJoin(bots, and(eq(bots.id, latest.botId), eq(bots.ownerId, userId), workspaceId ? eq(bots.workspaceId, workspaceId) : undefined))
    .where(inArray(issues.id, [...issueIds]))
  return rows.map(row => ({ ...row, failureDetails: readCompactRunFailure(row.failureDetails) }))
}
