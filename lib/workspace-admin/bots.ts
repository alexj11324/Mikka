import 'server-only'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, issues, githubRepositoryInstallations, WORKSPACE_BOT_MODELS, workspaceSettings, type WorkspaceBotModel } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { issueVisibility } from '@/lib/issue-visibility'
import { BOT_MODEL_GROUPS, botThreadsInput, botThreadTitle, decodeBotThreadCursor, encodeBotThreadCursor, type BotModelGroup } from '@/lib/workspace-admin/bot-threads'

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
  /** agent_runs.id */
  id: string
  /** Task title or the thread's opening line; null when the viewer may not see it (show 私有线程). */
  title: string | null
  /** 运行中 for any unfinished run (queued included), else 已完成 (done, failed or stopped). */
  status: 'running' | 'done'
  updatedAt: string
}

export interface BotThreadPage {
  bot: { id: string; name: string }
  threads: BotThreadView[]
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

/**
 * WS-07 线程列表: one bot's threads (its agent runs), newest first. Any active
 * member of the bot's workspace may read the list, like workspaceBots; titles
 * follow botThreadTitle's visibility rule. Keyset on (createdAt, id) DESC.
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
  const after = position
    ? sql`(${agentRuns.createdAt}, ${agentRuns.id}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`
    : undefined
  const rows = await db.select({
    id: agentRuns.id, userId: agentRuns.userId, issueId: agentRuns.issueId, status: agentRuns.status, prompt: agentRuns.prompt,
    createdAt: sql<string>`to_char(${agentRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    updatedAt: agentRuns.updatedAt, issueTitle: issues.title,
  }).from(agentRuns).leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.botId, botId), after)).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(limit + 1)
  const page = rows.slice(0, limit)
  const issueIds = [...new Set(page.flatMap(row => row.issueId && row.issueTitle !== null ? [row.issueId] : []))]
  let visible = new Set<string>()
  if (issueIds.length) {
    const { predicate } = await issueVisibility(viewerId, false, workspaceId)
    const seen = await db.select({ id: issues.id }).from(issues).where(and(inArray(issues.id, issueIds), predicate))
    visible = new Set(seen.map(row => row.id))
  }
  const unfinished = new Set<string>(UNFINISHED_RUN_STATUSES)
  const threads = page.map(row => ({
    id: row.id,
    title: botThreadTitle({ issueTitle: row.issueTitle, issueVisible: !!row.issueId && visible.has(row.issueId), prompt: row.prompt, startedByViewer: row.userId === viewerId }),
    status: unfinished.has(row.status) ? 'running' as const : 'done' as const,
    updatedAt: row.updatedAt.toISOString(),
  }))
  const last = page.at(-1)
  return { bot, threads, nextCursor: rows.length > limit && last ? encodeBotThreadCursor({ createdAt: last.createdAt, id: last.id }) : null }
}
