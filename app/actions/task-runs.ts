'use server'

import { headers } from 'next/headers'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, type RunStatus } from '@/lib/db/schema'
import { reclaimLostRuns } from '@/lib/run-leases'

/** The newest run on each issue, for the right column's 我的任务 groups (MIK-38). */
export interface TaskRun {
  issueId: string
  agentId: string
  agentName: string
  status: RunStatus
  error: string | null
  finishedAt: string | null
}

export async function listTaskRuns(): Promise<TaskRun[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  // The app polls this list, so a run whose device went offline is retried
  // (or lands in 等你) even when none of the person's devices is online.
  await reclaimLostRuns(session.user.id).catch((error: unknown) => console.error('Could not reclaim lost runs', error instanceof Error ? error.message : error))
  const rows = await db.selectDistinctOn([agentRuns.issueId], {
    issueId: agentRuns.issueId, agentId: agentRuns.agentId, agentName: agents.name,
    status: agentRuns.status, error: agentRuns.error, finishedAt: agentRuns.finishedAt,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, session.user.id), isNotNull(agentRuns.issueId), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt)).limit(200)
  return rows.map(row => ({ ...row, issueId: row.issueId!, finishedAt: row.finishedAt?.toISOString() ?? null }))
}
