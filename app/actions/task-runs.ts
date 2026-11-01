'use server'

import { headers } from 'next/headers'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, type RunStatus } from '@/lib/db/schema'
import { reclaimLostRuns } from '@/lib/run-leases'
import { runAgentName, runBotId, runBotName } from '@/lib/run-bot-name'
import { replyLine } from '@/lib/thread-groups'
import { runWaitingDeviceId } from '@/lib/run-waiting-for'

/** The newest run on each issue, for the right column's 我的任务 groups (MIK-38). */
export interface TaskRun {
  issueId: string
  issueTitle: string
  agentId: string
  /** The Agent running the newest thread (Claude Code, Codex): the desktop notification's line (R-78). */
  agentName: string
  status: RunStatus
  error: string | null
  finishedAt: string | null
  /** The Bot that owns the task's newest thread, with its own bloub look (R-25); null for the Coordinator's own work. */
  bot: { id: string; name: string; color: string; shape: string } | null
  /** The coding agents (harnesses) of the task's threads, newest first: the board card's agent marks. */
  harnesses: string[]
}

export async function listTaskRuns(): Promise<TaskRun[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  // The app polls this list, so a run whose device went offline is retried
  // (or lands in 等你) even when none of the person's devices is online.
  await reclaimLostRuns(session.user.id).catch((error: unknown) => console.error('Could not reclaim lost runs', error instanceof Error ? error.message : error))
  const rows = await db.selectDistinctOn([agentRuns.issueId], {
    issueId: agentRuns.issueId, issueTitle: issues.title, agentId: agentRuns.agentId, agentName: runAgentName,
    status: agentRuns.status, error: agentRuns.error, finishedAt: agentRuns.finishedAt,
    botId: runBotId,
    harnesses: sql<string[]>`array(select a.harness from agent_runs r join agents a on a.id=r."agentId" where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."createdAt" > now() - interval '30 days' group by a.harness order by max(r."createdAt") desc)`,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.userId, session.user.id), isNotNull(agentRuns.issueId), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt)).limit(200)
  const botIds = [...new Set(rows.flatMap(row => row.botId ? [row.botId] : []))]
  const looks = botIds.length ? await db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots).where(and(eq(bots.ownerId, session.user.id), inArray(bots.id, botIds))) : []
  return rows.map(({ botId, ...row }) => ({ ...row, issueId: row.issueId!, finishedAt: row.finishedAt?.toISOString() ?? null, bot: looks.find(look => look.id === botId) ?? null }))
}

/** A thread: one run, newest first. Its name comes from its task, else its prompt. */
export interface Thread {
  id: string
  /** The bot that started it; null when the Coordinator dispatched it to an agent. */
  botId: string | null
  /** 'mcp' when an MCP client dispatched it: not the Coordinator's, though it has no bot either. */
  source: 'mcp' | null
  /** The Bot that dispatched it; the Agent running it is `harness` (R-78). */
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
  /** The coding agent running it (claude_code, codex…); its mark is the thread's icon (R-78). */
  harness: string | null
  waitingFor?: { deviceId: string; deviceName: string; deviceType: 'laptop' | 'server'; harness: string }
}

/** The right column's threads: every run the Coordinator or a bot started in the last 30 days, latest activity first. */
export async function listThreads(): Promise<Thread[]> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const rows = await db.select({
    id: agentRuns.id, botId: agentRuns.botId, agentName: runBotName, issueId: agentRuns.issueId, prompt: sql<string>`left(${agentRuns.prompt}, 200)`,
    status: agentRuns.status, error: agentRuns.error, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
    lastReply: agentRuns.lastReply, lastReplyAt: agentRuns.lastReplyAt, source: agentRuns.source,
    ownerId: agentRuns.userId, deviceId: devices.id, deviceName: devices.name, deviceType: devices.deviceType,
    deviceEnabled: devices.enabled, lastSeenAt: devices.lastSeenAt,
    harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
    superseded: sql<boolean>`exists (select 1 from agent_runs retry where retry."retryOf" = ${agentRuns.id})`,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.userId, session.user.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(desc(sql`greatest(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt})`), desc(agentRuns.createdAt)).limit(200)
  return rows.map(({ ownerId, deviceId, deviceName, deviceType, deviceEnabled, lastSeenAt, harness, ...row }) => ({
    ...(runWaitingDeviceId(session.user.id, { ownerId, status: row.status, deviceId, deviceEnabled, lastSeenAt }) && deviceId && deviceName !== null && deviceType
      ? { waitingFor: { deviceId, deviceName, deviceType, harness } } : {}),
    ...row, harness: harness ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lastReply: replyLine(row.lastReply), lastReplyAt: row.lastReplyAt?.toISOString() ?? null, superseded: Boolean(row.superseded),
  }))
}
