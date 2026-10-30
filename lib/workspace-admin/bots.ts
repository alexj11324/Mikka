import 'server-only'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, issues, users, githubRepositoryInstallations, WORKSPACE_BOT_MODELS, workspaceSettings, type WorkspaceBotModel } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { issueVisibility } from '@/lib/issue-visibility'
import { BOT_MODEL_GROUPS, botThreadsInput, botThreadHref, botThreadTitle, decodeBotThreadCursor, encodeBotThreadCursor, type BotModelGroup } from '@/lib/workspace-admin/bot-threads'

export interface BotDefaults { defaultModel: WorkspaceBotModel | null; defaultRepository: string | null }
export interface BotDefaultOptions extends BotDefaults {
  /** 'mikka' is Mikka's hosted model; 'codex' / 'claude' use the bot owner's connected subscription. */
  models: readonly WorkspaceBotModel[]
  /** The 模型 menu: Mikka 默认 / Codex / Claude, in order (WS-05). */
  modelGroups: readonly BotModelGroup[]
  /** owner/repo remote keys from the GitHub App installations of the workspace's active members. */
  repositories: string[]
}

export const botDefaultsInput = z.object({
  defaultModel: z.enum(WORKSPACE_BOT_MODELS).nullable().optional(),
  defaultRepository: z.string().trim().min(1).max(300).nullable().optional(),
}).strict()

async function activeMemberIds(workspaceId: string) {
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))
  return rows.map(row => row.userId)
}

async function installedRepositories(workspaceId: string) {
  const members = await activeMemberIds(workspaceId)
  if (!members.length) return []
  const rows = await db.selectDistinct({ remoteKey: githubRepositoryInstallations.remoteKey }).from(githubRepositoryInstallations)
    .where(inArray(githubRepositoryInstallations.userId, members)).orderBy(asc(githubRepositoryInstallations.remoteKey))
  return rows.map(row => row.remoteKey)
}

/** True when an active member of the workspace has installed this repository. */
export async function repositoryAvailable(workspaceId: string, repository: string): Promise<boolean> {
  return (await installedRepositories(workspaceId)).includes(repository)
}

/** The stored defaults; createBot falls back to these. */
export async function workspaceBotDefaults(workspaceId: string): Promise<BotDefaults> {
  const [row] = await db.select({ defaultModel: workspaceSettings.defaultModel, defaultRepository: workspaceSettings.defaultRepository })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1)
  return { defaultModel: row?.defaultModel ?? null, defaultRepository: row?.defaultRepository ?? null }
}

/** 新 Bot 默认值 and what can be chosen. Any active member may read them. */
export async function botDefaultOptions(workspaceId: string): Promise<BotDefaultOptions> {
  const [defaults, repositories] = await Promise.all([workspaceBotDefaults(workspaceId), installedRepositories(workspaceId)])
  return { ...defaults, models: WORKSPACE_BOT_MODELS, modelGroups: BOT_MODEL_GROUPS, repositories }
}

/** Admins only. A repository must be installed by an active member; null clears a default. */
export async function saveBotDefaults(actorId: string, workspaceId: string, input: z.input<typeof botDefaultsInput>): Promise<BotDefaults> {
  const values = botDefaultsInput.parse(input)
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    if (values.defaultRepository && !(await repositoryAvailable(workspaceId, values.defaultRepository))) {
      throw new WorkspaceError('botDefaultRepositoryUnavailable')
    }
    const changes = { ...values, updatedAt: new Date() }
    const [row] = await db.insert(workspaceSettings).values({ workspaceId, ...changes })
      .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: changes })
      .returning({ defaultModel: workspaceSettings.defaultModel, defaultRepository: workspaceSettings.defaultRepository })
    return row
  })
}

export interface WorkspaceBotView {
  id: string
  name: string
  color: string
  shape: string
  ownerId: string
  ownerName: string | null
  model: WorkspaceBotModel | null
  repository: string | null
  /** 空闲 when no thread is unfinished, else 运行中 · N 个线程. */
  status: 'idle' | 'running'
  runningThreads: number
}

/** Every bot in the workspace with its live thread count. Any active member may read it. */
export async function workspaceBots(workspaceId: string): Promise<WorkspaceBotView[]> {
  const [rows, names] = await Promise.all([
    db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape, ownerId: bots.ownerId, model: bots.model, repository: bots.repository })
      .from(bots).where(eq(bots.workspaceId, workspaceId)).orderBy(asc(bots.createdAt)),
    workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
  ])
  if (!rows.length) return []
  const live = await db.select({ botId: agentRuns.botId, total: count() }).from(agentRuns)
    .where(and(inArray(agentRuns.botId, rows.map(row => row.id)), inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]))).groupBy(agentRuns.botId)
  const threads = new Map(live.map(row => [row.botId, row.total]))
  const owners = new Map(names.map(row => [row.userId, row.name]))
  return rows.map(row => {
    const runningThreads = threads.get(row.id) ?? 0
    return { ...row, ownerName: owners.get(row.ownerId) ?? null, status: runningThreads ? 'running' : 'idle', runningThreads }
  })
}

export interface BotThreadView {
  /** Opaque row/cursor key (`t_` + 32 hex, see botThreadPublicId). Never contains an issue or user id. */
  threadId: string
  /** Who started the thread (first run's user). Shown to any workspace member, even when title is null. */
  initiator: { id: string; name: string | null; avatarUrl: string | null }
  /** Task title or the chat's opening line; null when the viewer may not see it (show 私有线程). */
  title: string | null
  /** The thread's latest run: 运行中 for any unfinished status (queued included), else 已完成. */
  status: 'running' | 'done'
  /** Latest activity across all of the thread's runs (updatedAt / lastReplyAt). */
  lastActivityAt: string
  /** True only when the viewer may open the thread. */
  canOpen: boolean
  /** In-app link to the thread; null when !canOpen. The only place a task id appears, and only for tasks the viewer can see. */
  href: string | null
}

export interface BotThreadPage {
  bot: { id: string; name: string }
  /** Drawer subtitle data (no text): every thread of this bot, open or not. */
  summary: { totalThreads: number; lastActivityAt: string | null }
  threads: BotThreadView[]
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

const iso = (column: ReturnType<typeof sql>) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/**
 * WS-07 线程列表: one bot's threads, most recently active first. Runs are
 * grouped per thread (a task, or one person's chat with the bot), so several
 * runs show as one row with the latest run's status. Any active member of the
 * bot's workspace may read the list; titles follow botThreadHref, botThreadTitle, and a
 * chat's prompt is only selected from the database for its own owner.
 * Keyset on (lastActivityAt, threadId) DESC with a row comparison.
 */
// TODO(audit): reading threads is not audited; if bot settings writes need audit, call
// recordAudit(tx, …) from lib/audit/record (PR #432) inside the bot/defaults update transaction.
export async function listBotThreadsFor(viewerId: string, workspaceId: string, input: unknown): Promise<BotThreadPage> {
  const { botId, limit, cursor } = botThreadsInput.parse(input)
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, viewerId))
  const [bot] = await db.select({ id: bots.id, name: bots.name }).from(bots).where(and(eq(bots.id, botId), eq(bots.workspaceId, workspaceId))).limit(1)
  if (!bot) throw new WorkspaceError('botNotFound')
  const position = cursor ? decodeBotThreadCursor(cursor) : null
  if (cursor && !position) throw new WorkspaceError('validationGeneric')
  const threadKey = sql`case when ${agentRuns.issueId} is not null then 'issue:' || ${agentRuns.issueId}::text else 'chat:' || ${agentRuns.userId} end`
  // Opaque public id, same formula as botThreadPublicId (sha256 of "<botId>:<key>", 32 hex).
  const publicId = sql`'t_' || left(encode(sha256(convert_to(${botId}::text || ':' || ${threadKey}, 'UTF8')), 'hex'), 32)`
  const activity = sql`greatest(${agentRuns.updatedAt}, coalesce(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt}))`
  const runs = db.$with('bot_thread_runs').as(db.select({
    threadId: sql<string>`${publicId}`.as('threadId'),
    issueId: agentRuns.issueId,
    ownerId: agentRuns.userId,
    status: agentRuns.status,
    createdAt: agentRuns.createdAt,
    id: agentRuns.id,
    activity: sql<Date>`${activity}`.as('activity'),
    // The prompt leaves the database only for the viewer's own chat runs.
    prompt: sql<string | null>`case when ${agentRuns.issueId} is null and ${agentRuns.userId} = ${viewerId} then ${agentRuns.prompt} end`.as('prompt'),
  }).from(agentRuns).where(eq(agentRuns.botId, botId)))
  const threads = db.$with('bot_threads').as(db.with(runs).selectDistinctOn([runs.threadId], {
    threadId: runs.threadId, issueId: runs.issueId, ownerId: runs.ownerId, status: runs.status,
    lastActivity: sql<Date>`max(${runs.activity}) over (partition by ${runs.threadId})`.as('lastActivity'),
    initiatorId: sql<string>`first_value(${runs.ownerId}) over (partition by ${runs.threadId} order by ${runs.createdAt}, ${runs.id})`.as('initiatorId'),
    opening: sql<string | null>`first_value(${runs.prompt}) over (partition by ${runs.threadId} order by ${runs.createdAt}, ${runs.id})`.as('opening'),
  }).from(runs).orderBy(runs.threadId, desc(runs.createdAt), desc(runs.id)))
  const after = position ? sql`(${threads.lastActivity}, ${threads.threadId}) < (${position.at}::timestamptz, ${position.threadId})` : undefined
  const rows = await db.with(runs, threads).select({
    threadId: threads.threadId, issueId: threads.issueId, ownerId: threads.ownerId, initiatorId: threads.initiatorId, status: threads.status, opening: threads.opening,
    lastActivityAt: iso(sql`${threads.lastActivity}`), issueTitle: issues.title,
  }).from(threads).leftJoin(issues, eq(issues.id, threads.issueId))
    .where(after).orderBy(desc(threads.lastActivity), desc(threads.threadId)).limit(limit + 1)
  const [summary] = await db.with(runs).select({
    totalThreads: sql<number>`count(distinct ${runs.threadId})::int`,
    lastActivityAt: sql<string | null>`to_char(max(${runs.activity}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(runs)
  const page = rows.slice(0, limit)
  const issueIds = [...new Set(page.flatMap(row => row.issueId && row.issueTitle !== null ? [row.issueId] : []))]
  let visible = new Set<string>()
  if (issueIds.length) {
    const { predicate } = await issueVisibility(viewerId, false, workspaceId)
    const seen = await db.select({ id: issues.id }).from(issues).where(and(inArray(issues.id, issueIds), predicate))
    visible = new Set(seen.map(row => row.id))
  }
  // Initiators: member display name (workspace DB) and profile picture (app DB). Any active member may see these.
  const initiatorIds = [...new Set(page.map(row => row.initiatorId))]
  const [memberNames, pictures] = initiatorIds.length ? await Promise.all([
    workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, initiatorIds))),
    db.select({ id: users.id, name: users.name, image: users.image }).from(users).where(inArray(users.id, initiatorIds)),
  ]) : [[], []]
  const memberName = new Map(memberNames.map(row => [row.userId, row.name]))
  const profile = new Map(pictures.map(row => [row.id, row]))
  const unfinished = new Set<string>(UNFINISHED_RUN_STATUSES)
  const views = page.map(row => {
    const issueVisible = !!row.issueId && visible.has(row.issueId)
    const href = botThreadHref({ issueId: row.issueId, ownerId: row.ownerId, botId }, { id: viewerId, issueVisible })
    return {
      threadId: row.threadId,
      initiator: { id: row.initiatorId, name: memberName.get(row.initiatorId) ?? profile.get(row.initiatorId)?.name ?? null, avatarUrl: profile.get(row.initiatorId)?.image ?? null },
      title: botThreadTitle({ issueTitle: row.issueTitle, issueVisible, prompt: row.opening, startedByViewer: row.ownerId === viewerId }),
      status: unfinished.has(row.status) ? 'running' as const : 'done' as const,
      lastActivityAt: row.lastActivityAt,
      canOpen: href !== null,
      href,
    }
  })
  const last = page.at(-1)
  return {
    bot,
    summary: { totalThreads: summary?.totalThreads ?? 0, lastActivityAt: summary?.lastActivityAt ?? null },
    threads: views,
    nextCursor: rows.length > limit && last ? encodeBotThreadCursor({ at: last.lastActivityAt, threadId: last.threadId }) : null,
  }
}
