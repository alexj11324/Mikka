'use server'

import { headers } from 'next/headers'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, type RunStatus } from '@/lib/db/schema'
import { reclaimLostRuns } from '@/lib/run-leases'
import { LAST_REPLY_CHARS, replyLine } from '@/lib/thread-groups'

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
  /** Who runs it. */
  agentName: string
  issueId: string | null
  prompt: string
  status: RunStatus
  error: string | null
  createdAt: string
  /** Last activity, for the 全部线程 row's time. */
  updatedAt: string
  /** The opening of the agent's last reply, verbatim, on one line; null before it says anything. */
  lastReply: string | null
}

/**
 * The opening of a run's last reply: the deltas of its last text part
 * (every adapter starts a part with `text-start`), read from the run's chunk
 * index without an LLM. Only the opening is kept; the row shows one line.
 */
const lastReplySql = sql<string | null>`(
  select left(string_agg(part.chunk->>'delta', '' order by part.seq), ${LAST_REPLY_CHARS}::int)
  from (
    select d.chunk, d.seq from run_chunks d,
      (select s.seq, s.chunk->>'id' as id from run_chunks s
        where s."runId" = ${agentRuns.id} and s.chunk->>'type' = 'text-start' order by s.seq desc limit 1) start
    where d."runId" = ${agentRuns.id} and d.seq > start.seq and d.chunk->>'type' = 'text-delta' and d.chunk->>'id' = start.id
    order by d.seq limit 40
  ) part
)`

/** The right column's threads: every run the Coordinator or a bot started in the last 30 days. */
export async function listThreads(): Promise<Thread[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const rows = await db.select({
    id: agentRuns.id, botId: agentRuns.botId, agentName: agents.name, issueId: agentRuns.issueId, prompt: sql<string>`left(${agentRuns.prompt}, 200)`,
    status: agentRuns.status, error: agentRuns.error, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt, lastReply: lastReplySql,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, session.user.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(desc(agentRuns.createdAt)).limit(200)
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastReply: replyLine(row.lastReply) }))
}
