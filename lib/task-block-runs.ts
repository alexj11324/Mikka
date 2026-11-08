import 'server-only'

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import { agentRuns, agents, bots, issues } from '@/lib/db/schema'
import { runBotId } from '@/lib/run-bot-name'
import type { ThreadOutcome } from '@/lib/thread-groups'
import type { MobileTaskBot, MobileTaskSchedule } from '@/lib/mobile-task-view'
import type { Definition } from '@/lib/schedules/contract'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from './run-failure-projection'

/**
 * Each listed task's newest thread from the last 30 days, as far as 受阻 needs it
 * (lib/task-blocked.ts): the same window and owner as the web's listTaskRuns.
 * One small read beside the task list, which the 任务 list already makes.
 */
export type TaskRunSnapshot = { issueId: string; runId: string | null; status: string | null; outcome: ThreadOutcome | null; failureDetails: CompactRunFailure | null; bot: MobileTaskBot | null; schedule: MobileTaskSchedule | null }
type ScheduleRow = { title: string; timing: Definition['timing']; nextAt: string | null }
type ScheduleLabels = { daily: (time: string) => string; interval: (minutes: number) => string }

export async function taskScheduleLabels(): Promise<ScheduleLabels> {
  const t = await getTranslations('MobileTaskSchedule')
  return { daily: time => t('daily', { time }), interval: minutes => t('interval', { minutes }) }
}

export function taskScheduleView(schedule: ScheduleRow | null, labels?: ScheduleLabels): MobileTaskSchedule | null {
  if (!schedule) return null
  const label = labels && schedule.timing.kind === 'daily' ? labels.daily(schedule.timing.time)
    : labels && schedule.timing.kind === 'interval' ? labels.interval(schedule.timing.minutes) : schedule.title
  return { label, nextAt: schedule.nextAt }
}

/** Schedule definitions explicitly linked to this task. Never attach every schedule of its Bot. */
export function taskSchedule(issueId: typeof issues.id, userId: string, workspaceId?: string) {
  return sql<ScheduleRow | null>`(select jsonb_build_object('title', s.definition->>'title', 'timing', s.definition->'timing', 'nextAt', s.next_at)
    from user_schedules s where s.owner_id=${userId} and s.definition->'task'->>'kind'='issue_snapshot'
      and s.definition->'task'->>'issueId'=${issueId}::text and s.status in ('active','paused')
      and s.workspace_id=${issues.workspaceId}
      ${workspaceId ? sql`and s.workspace_id=${workspaceId}::uuid` : sql``}
    order by s.next_at asc nulls last, s.id limit 1)`
}

export async function newestTaskRuns(userId: string, issueIds: readonly string[], workspaceId?: string, labels?: ScheduleLabels): Promise<TaskRunSnapshot[]> {
  if (!issueIds.length) return []
  const latest = db.selectDistinctOn([agentRuns.issueId], { issueId: agentRuns.issueId, runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'), botId: runBotId.as('botId') })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .innerJoin(issues, and(eq(issues.id, agentRuns.issueId), eq(issues.ownershipState, 'bound'), eq(agentRuns.workspaceId, issues.workspaceId)))
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.issueId, [...issueIds]), workspaceId ? eq(issues.workspaceId, workspaceId) : undefined,
      sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).as('newest_task_runs')
  // Callers supply already-authorized task IDs. Keep every source on each
  // task's persisted tenant, including pending/legacy run exclusion, even when
  // no explicit workspace filter was supplied. All decorations share one read.
  const rows = await db.select({ issueId: issues.id, runId: latest.runId, status: latest.status, outcome: latest.outcome, failureDetails: latest.failureDetails,
    bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }, schedule: taskSchedule(issues.id, userId, workspaceId),
  }).from(issues).leftJoin(latest, eq(latest.issueId, issues.id))
    .leftJoin(bots, and(eq(bots.id, latest.botId), eq(bots.ownerId, userId), eq(bots.workspaceId, issues.workspaceId)))
    .where(and(inArray(issues.id, [...issueIds]), eq(issues.ownershipState, 'bound'), workspaceId ? eq(issues.workspaceId, workspaceId) : undefined))
  return rows.map(row => ({ ...row, schedule: taskScheduleView(row.schedule, labels), failureDetails: readCompactRunFailure(row.failureDetails) }))
}
