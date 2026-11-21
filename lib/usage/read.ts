import 'server-only'
import type { ExecutionIdentity } from '../execution-identity'
import { executionAccountUsage, type ExecutionAccountUsage } from './execution-accounts'
// 用量 (V14 / S-A) read model from data that exists today: threads (run chains)
// per bot and their run time. There is no credit meter yet, so no points.
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { listBotRunRoots } from '@/lib/run-chain'
import { agentRuns, bots } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { monthBounds, monthDays } from './month'

/**
 * `threads` counts the threads a bot started in the month (the 新线程 column and the
 * daily bars); `seconds` is run time spent in the month, so a thread that started
 * last month and ran on adds time with no new thread.
 */
export interface UsageRow { id: string; name: string; threads: number; seconds: number; /** The bots of someone who deleted their account: 「待接管」, no name. */ awaitingTakeover?: true }
export interface BotUsageRow extends UsageRow { color: string; shape: string; ownerId: string | null }
export interface WorkspaceUsage {
  month: string
  /** Only the requester sees their own model/runtime account references, including on a shared Bot. */
  executionAccounts?: ExecutionAccountUsage[]
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
  // This per-Bot column counts only runs a Bot dispatched (agent_runs.botId), so an
  // MCP client's run — which has no botId by contract (lib/computer/queue-run.ts:119) —
  // is absent here on purpose, the same way lib/mobile-threads.ts omits it. Do not
  // "fix" this filter to include those runs: a Bot column means "threads this Bot
  // dispatched", and nothing dispatched them.
  // The time is not lost from the page. `executionAccounts` below reads the same month
  // by execution identity, and its query filters on the run's own "userId", so an MCP
  // run lands there under whoever ran it. The two paths are not nested: A covers every
  // run a workspace Bot dispatched, B every run *this viewer* ran, so an admin's B
  // omits a teammate's Bot runs. Neither is a charge: those rows carry costMicroUsd
  // null and chargedByMikka false, and credits settle from hosted_usage per model call
  // (lib/abuse/store.ts), which has no botId column.
  // ALE-77 measured all of this on a seeded database; see the issue before reopening it.
  const perBot = ids.length ? await db.select({ botId: agentRuns.botId, seconds })
    .from(agentRuns)
    .where(and(inArray(agentRuns.botId, ids), lt(agentRuns.createdAt, end), sql`(${agentRuns.finishedAt} is null or ${agentRuns.finishedAt} >= ${start}::timestamptz)`))
    .groupBy(agentRuns.botId) : []
  const roots = await listBotRunRoots(pool, ids, start, end)
  const threadsByBot = new Map<string, number>()
  const byDay = new Map<string, number>()
  for (const root of roots) {
    threadsByBot.set(root.botId, (threadsByBot.get(root.botId) ?? 0) + 1)
    const day = root.createdAt.toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  const usage = new Map(perBot.map(row => [row.botId, row]))
  const botUsage = botRows.map(bot => ({ ...bot, threads: threadsByBot.get(bot.id) ?? 0, seconds: Math.round(Number(usage.get(bot.id)?.seconds ?? 0)) }))
    .sort((a, b) => b.threads - a.threads || b.seconds - a.seconds || a.name.localeCompare(b.name))
  const owners = [...new Set(botUsage.map(bot => bot.ownerId))]
  const named = owners.filter((owner): owner is string => owner !== null)
  const names = named.length ? new Map((await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name, email: workspaceMembers.email }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, named)))).map(row => [row.userId, row.name || row.email])) : new Map<string, string>()
  const memberUsage = owners.map(ownerId => {
    const mine = botUsage.filter(bot => bot.ownerId === ownerId)
    const totals = { threads: mine.reduce((sum, bot) => sum + bot.threads, 0), seconds: mine.reduce((sum, bot) => sum + bot.seconds, 0) }
    if (ownerId === null) return { id: '', name: '', awaitingTakeover: true as const, ...totals }
    return { id: ownerId, name: names.get(ownerId) ?? ownerId, threads: mine.reduce((sum, bot) => sum + bot.threads, 0), seconds: mine.reduce((sum, bot) => sum + bot.seconds, 0) }
  }).sort((a, b) => b.threads - a.threads || b.seconds - a.seconds)
  const { rows: accountRuns } = await pool.query<{ identity: ExecutionIdentity | null; seconds: number }>(`SELECT "agentDefinition"->'executionIdentity' AS identity,
    CASE WHEN "startedAt" IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM (least(COALESCE("finishedAt",now()),$4::timestamptz)-greatest("startedAt",$3::timestamptz))))::float8 END AS seconds
    FROM agent_runs WHERE "userId"=$1 AND "agentDefinition"->'executionIdentity'->>'workspaceId'=$2
      AND "createdAt"<$4 AND ("finishedAt" IS NULL OR "finishedAt">=$3)`, [actorId, workspaceId, start, end])
  const executionAccounts = executionAccountUsage(accountRuns)
  const accountOwners = [...new Set(executionAccounts.map(account => account.ownerId))]
  const accountNames = accountOwners.length ? new Map((await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, accountOwners)))).map(member => [member.userId, member.name])) : new Map<string, string>()
  for (const account of executionAccounts) account.ownerName = accountNames.get(account.ownerId) || account.ownerId
  if (admin) await (await import('../abuse/runtime')).ensureLegacyVerification(workspaceId)
  return {
    ...(admin ? {hosted:await (await import('../abuse/runtime')).hostedUsage.status(workspaceId)} : {}),
    month, executionAccounts, scope: admin ? 'workspace' : 'own',
    totals: { threads: botUsage.reduce((sum, bot) => sum + bot.threads, 0), seconds: botUsage.reduce((sum, bot) => sum + bot.seconds, 0) },
    bots: botUsage, members: memberUsage,
    daily: monthDays(month).map(date => ({ date, threads: byDay.get(date) ?? 0 })),
  }
}
