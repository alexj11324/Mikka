'use server'

import { headers } from 'next/headers'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, type RunStatus } from '@/lib/db/schema'
import { reclaimLostRuns } from '@/lib/run-leases'
import { replyLine } from '@/lib/thread-groups'

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

/** A thread: one run, newest first. Its name comes from its task, else its prompt. */
export interface Thread {
  id: string
  /** The bot that started it; null when the Coordinator dispatched it to an agent. */
  botId: string | null
  /** 'mcp' when an MCP client dispatched it: not the Coordinator's, though it has no bot either. */
  source: 'mcp' | null
  /** Who runs it. */
  agentName: string
  issueId: string | null
  prompt: string
  status: RunStatus
  error: string | null
  createdAt: string
  updatedAt: string
  /** The opening of the agent's last reply on one plain line; null before it says anything (and for runs from before it was stored). */
  lastReply: string | null
  /** When that reply was last written; with updatedAt, the row's last activity. */
  lastReplyAt: string | null
  /** A retry of this run exists (it went offline and was queued again), so it no longer waits on anyone. */
  superseded: boolean
}

/** The right column's threads: every run the Coordinator or a bot started in the last 30 days, latest activity first. */
export async function listThreads(): Promise<Thread[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const rows = await db.select({
    id: agentRuns.id, botId: agentRuns.botId, agentName: agents.name, issueId: agentRuns.issueId, prompt: sql<string>`left(${agentRuns.prompt}, 200)`,
    status: agentRuns.status, error: agentRuns.error, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
    lastReply: agentRuns.lastReply, lastReplyAt: agentRuns.lastReplyAt, source: agentRuns.source,
    superseded: sql<boolean>`exists (select 1 from agent_runs retry where retry."retryOf" = ${agentRuns.id})`,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, session.user.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(desc(sql`coalesce(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt})`), desc(agentRuns.createdAt)).limit(200)
  return rows.map(row => ({
    ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lastReply: replyLine(row.lastReply), lastReplyAt: row.lastReplyAt?.toISOString() ?? null, superseded: Boolean(row.superseded),
  }))
}
