import 'server-only'
// 用量 (V14 / S-A) read model from data that exists today: threads (agent_runs)
// per bot and their run time. There is no credit meter yet, so no points.
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, bots } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { monthBounds, monthDays } from './month'

export interface UsageRow { id: string; name: string; threads: number; seconds: number }
export interface BotUsageRow extends UsageRow { color: string; shape: string; ownerId: string }
export interface WorkspaceUsage {
  month: string
  hosted?: Awaited<ReturnType<typeof import('../abuse/runtime')['hostedUsage']['status']>>
  /** Admins see every bot and member; members only their own bots (S-A). */
  scope: 'workspace' | 'own'
  totals: { threads: number; seconds: number }
  bots: BotUsageRow[]
  members: UsageRow[]
  daily: Array<{ date: string; threads: number }>
}

export async function workspaceUsage(actorId: string, workspaceId: string, month: string): Promise<WorkspaceUsage> {
  const { start, end } = monthBounds(month)
  const { membership } = await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  const admin = membership.role === 'admin'
  const botRows = await db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, ownerId: bots.ownerId }).from(bots)
    .where(and(eq(bots.workspaceId, workspaceId), admin ? undefined : eq(bots.ownerId, actorId)))
  const ids = botRows.map(bot => bot.id)
  // Run time is the part of each run that falls inside the month; a run still going counts up to now.
  const seconds = sql<number>`coalesce(sum(case when ${agentRuns.startedAt} is null then 0 else greatest(0, extract(epoch from (least(coalesce(${agentRuns.finishedAt}, now()), ${end}::timestamptz) - greatest(${agentRuns.startedAt}, ${start}::timestamptz)))) end), 0)::float8`
  // Runs that overlap the month: created before its end and not finished before its start.
  const perBot = ids.length ? await db.select({ botId: agentRuns.botId, threads: sql<number>`(count(*) filter (where ${agentRuns.createdAt} >= ${start}::timestamptz))::int`, seconds })
    .from(agentRuns)
    .where(and(inArray(agentRuns.botId, ids), lt(agentRuns.createdAt, end), sql`(${agentRuns.finishedAt} is null or ${agentRuns.finishedAt} >= ${start}::timestamptz)`))
    .groupBy(agentRuns.botId) : []
  const daily = ids.length ? await db.select({ date: sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, threads: sql<number>`count(*)::int` })
    .from(agentRuns).where(and(inArray(agentRuns.botId, ids), gte(agentRuns.createdAt, start), lt(agentRuns.createdAt, end)))
    .groupBy(sql`1`) : []
  const usage = new Map(perBot.map(row => [row.botId, row]))
  const botUsage = botRows.map(bot => ({ ...bot, threads: usage.get(bot.id)?.threads ?? 0, seconds: Math.round(Number(usage.get(bot.id)?.seconds ?? 0)) }))
    .sort((a, b) => b.threads - a.threads || b.seconds - a.seconds || a.name.localeCompare(b.name))
  const owners = [...new Set(botUsage.map(bot => bot.ownerId))]
  const names = owners.length ? new Map((await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, owners)))).map(row => [row.userId, row.name || row.email])) : new Map<string, string>()
  const memberUsage = owners.map(ownerId => {
    const mine = botUsage.filter(bot => bot.ownerId === ownerId)
    return { id: ownerId, name: names.get(ownerId) ?? ownerId, threads: mine.reduce((sum, bot) => sum + bot.threads, 0), seconds: mine.reduce((sum, bot) => sum + bot.seconds, 0) }
  }).sort((a, b) => b.threads - a.threads || b.seconds - a.seconds)
  const byDay = new Map(daily.map(row => [row.date, row.threads]))
  if (admin) await (await import('../abuse/runtime')).ensureLegacyVerification(workspaceId)
  return {
    ...(admin ? {hosted:await (await import('../abuse/runtime')).hostedUsage.status(workspaceId)} : {}),
    month, scope: admin ? 'workspace' : 'own',
    totals: { threads: botUsage.reduce((sum, bot) => sum + bot.threads, 0), seconds: botUsage.reduce((sum, bot) => sum + bot.seconds, 0) },
    bots: botUsage, members: memberUsage,
    daily: monthDays(month).map(date => ({ date, threads: byDay.get(date) ?? 0 })),
  }
}
