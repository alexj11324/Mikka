import 'server-only'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, issues, users, githubRepositoryInstallations, workspaceSettings, type WorkspaceBotModel } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { issueVisibility } from '@/lib/issue-visibility'
import { allowedModelsOf, botSettingsInput, modelPolicyInput, resolveBotModel, resolveBotRepository } from '@/lib/workspace-admin/bot-model-policy'
import { BOT_MODEL_GROUPS, botThreadsInput, botThreadHref, botThreadTitle, decodeBotThreadCursor, encodeBotThreadCursor, type BotModelGroup } from '@/lib/workspace-admin/bot-threads'

export interface ModelPolicy {
  /** 可用模型 in menu order; every family until an admin saves. */
  allowedModels: WorkspaceBotModel[]
  /** The model a new bot starts with; null = the first allowed family. */
  startingModel: WorkspaceBotModel | null
  /** Optimistic-lock version; send it back as expectedVersion. */
  version: number
  /** The 模型 menu: Mikka 默认 / Codex / Claude, in order (WS-05). */
  modelGroups: readonly BotModelGroup[]
}

/** expectedVersion no longer matches: another admin saved first. Carries the current policy. */
export class ModelPolicyConflictError extends WorkspaceError {
  constructor(readonly current: ModelPolicy) { super('modelPolicyConflict') }
}

async function activeMemberIds(workspaceId: string) {
  const rows = await workspaceDb.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))
  return rows.map(row => row.userId)
}

/** owner/repo keys the GitHub App installations of the workspace's active members cover. */
export async function installedRepositories(workspaceId: string) {
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

type Reader = Pick<typeof db, 'select'>

/** 可用模型 and the starting model. Any active member may read it (their bots' menus come from it). */
export async function modelPolicy(workspaceId: string, reader: Reader = db): Promise<ModelPolicy> {
  const [row] = await reader.select({ allowedModels: workspaceSettings.allowedModels, startingModel: workspaceSettings.defaultModel, version: workspaceSettings.modelPolicyVersion })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1)
  const allowedModels = allowedModelsOf(row?.allowedModels)
  const startingModel = row?.startingModel && allowedModels.includes(row.startingModel) ? row.startingModel : null
  return { allowedModels, startingModel, version: row?.version ?? 0, modelGroups: BOT_MODEL_GROUPS }
}

/** What createBot writes when the caller does not choose: the starting model, or the first allowed family. */
export async function newBotModel(workspaceId: string): Promise<WorkspaceBotModel | null> {
  const policy = await modelPolicy(workspaceId)
  return policy.startingModel ?? policy.allowedModels[0] ?? null
}

/** True when `model` is in the workspace's 可用模型. */
export async function modelAllowed(workspaceId: string, model: WorkspaceBotModel): Promise<boolean> {
  return (await modelPolicy(workspaceId)).allowedModels.includes(model)
}

/**
 * Admins only. Saves 可用模型 (at least one family) and the starting model, which
 * must be one of them. The workspace row lock (requireWorkspace(..., true))
 * serialises admins; with expectedVersion the write is also a compare-and-set
 * on modelPolicyVersion, and a stale version throws ModelPolicyConflictError.
 * Bots whose model is no longer allowed keep their stored choice and run on the
 * fallback (resolveBotModel) until their owner picks again.
 */
export async function saveModelPolicy(actorId: string, workspaceId: string, input: z.input<typeof modelPolicyInput>): Promise<ModelPolicy> {
  const { expectedVersion, allowedModels, startingModel } = modelPolicyInput.parse(input)
  if (startingModel && !allowedModels.includes(startingModel)) throw new WorkspaceError('botModelNotAllowed')
  const ordered = allowedModelsOf(allowedModels)
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    await db.insert(workspaceSettings).values({ workspaceId }).onConflictDoNothing({ target: workspaceSettings.workspaceId })
    const match = expectedVersion === undefined
      ? eq(workspaceSettings.workspaceId, workspaceId)
      : and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.modelPolicyVersion, expectedVersion))
    const [row] = await db.update(workspaceSettings)
      .set({ allowedModels: ordered, defaultModel: startingModel, modelPolicyVersion: sql`${workspaceSettings.modelPolicyVersion} + 1`, updatedAt: new Date() })
      .where(match).returning({ version: workspaceSettings.modelPolicyVersion })
    if (!row) throw new ModelPolicyConflictError(await modelPolicy(workspaceId))
    return { allowedModels: ordered, startingModel, version: row.version, modelGroups: BOT_MODEL_GROUPS }
  })
}

export interface BotSettingsView {
  bot: { id: string; name: string; ownerId: string }
  /** Only the bot's owner may change its settings; everyone else reads them. */
  canEdit: boolean
  /** The owner's stored choices. */
  model: WorkspaceBotModel | null
  repository: string | null
  /** What the bot runs on now (resolveBotModel / resolveBotRepository). */
  effectiveModel: WorkspaceBotModel | null
  effectiveRepository: string | null
  /** The stored model is no longer in 可用模型. */
  modelUnavailable: boolean
  /** The stored repository is no longer covered by the workspace's GitHub App installations. */
  repositoryUnavailable: boolean
  /** The choices: 可用模型 and the installed repositories. */
  allowedModels: WorkspaceBotModel[]
  repositories: string[]
  modelGroups: readonly BotModelGroup[]
  /**
   * Codex / Claude run on the owner's own subscription (设置 › 模型订阅). The providers the
   * owner has connected in this workspace; empty for anyone but the owner (never another person's accounts).
   */
  connectedProviders: Array<'codex' | 'claude'>
}

/** Providers the person has a live connection for in this workspace (byos_connections). */
async function connectedProviders(ownerId: string, workspaceId: string): Promise<Array<'codex' | 'claude'>> {
  const { rows } = await db.execute<{ provider: 'codex' | 'claude' }>(sql`select distinct provider from byos_connections where "ownerId" = ${ownerId} and "workspaceId" = ${workspaceId} and state = 'connected' and "removedAt" is null order by provider`)
  return rows.map(row => row.provider)
}

async function botIn(workspaceId: string, botId: string, reader: Reader = db) {
  const [bot] = await reader.select({ id: bots.id, name: bots.name, ownerId: bots.ownerId, model: bots.model, repository: bots.repository })
    .from(bots).where(and(eq(bots.id, botId), eq(bots.workspaceId, workspaceId))).limit(1)
  if (!bot) throw new WorkspaceError('botNotFound')
  return bot
}

function settingsView(viewerId: string, bot: Awaited<ReturnType<typeof botIn>>, policy: ModelPolicy, repositories: string[], providers: Array<'codex' | 'claude'>): BotSettingsView {
  const model = resolveBotModel({ model: bot.model, allowedModels: policy.allowedModels, startingModel: policy.startingModel })
  const repository = resolveBotRepository(bot.repository, repositories)
  return {
    bot: { id: bot.id, name: bot.name, ownerId: bot.ownerId }, canEdit: bot.ownerId === viewerId,
    model: bot.model, repository: bot.repository,
    effectiveModel: model.model, effectiveRepository: repository.repository,
    modelUnavailable: model.unavailable, repositoryUnavailable: repository.unavailable,
    allowedModels: policy.allowedModels, repositories, modelGroups: policy.modelGroups,
    connectedProviders: bot.ownerId === viewerId ? providers : [],
  }
}

/** One bot's model and repository. Any active member of its workspace may read them. */
export async function botSettingsFor(viewerId: string, workspaceId: string, botId: string): Promise<BotSettingsView> {
  z.string().uuid().parse(botId)
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, viewerId))
  const [bot, policy, repositories, providers] = await Promise.all([botIn(workspaceId, botId), modelPolicy(workspaceId), installedRepositories(workspaceId), connectedProviders(viewerId, workspaceId)])
  return settingsView(viewerId, bot, policy, repositories, providers)
}

/**
 * The bot's owner only (admins included: an admin cannot change someone else's bot).
 * The model must be in 可用模型 and the repository covered by the workspace's GitHub
 * App installations. The settings row is held FOR SHARE while the bot is written, so an
 * admin's 可用模型 save cannot slip between the check and the write.
 */
export async function saveBotSettings(actorId: string, workspaceId: string, input: z.input<typeof botSettingsInput>): Promise<BotSettingsView> {
  const { botId, ...values } = botSettingsInput.parse(input)
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId))
  if (values.repository && !(await repositoryAvailable(workspaceId, values.repository))) throw new WorkspaceError('botRepositoryUnavailable')
  await db.insert(workspaceSettings).values({ workspaceId }).onConflictDoNothing({ target: workspaceSettings.workspaceId })
  const bot = await db.transaction(async tx => {
    await tx.select({ id: workspaceSettings.workspaceId }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).for('share')
    const current = await botIn(workspaceId, botId, tx)
    if (current.ownerId !== actorId) throw new WorkspaceError('botOwnerOnly')
    if (values.model && !(await modelPolicy(workspaceId, tx)).allowedModels.includes(values.model)) throw new WorkspaceError('botModelNotAllowed')
    if (values.model === undefined && values.repository === undefined) return current
    const [row] = await tx.update(bots).set({ ...values, updatedAt: new Date() })
      .where(and(eq(bots.id, botId), eq(bots.workspaceId, workspaceId), eq(bots.ownerId, actorId)))
      .returning({ id: bots.id, name: bots.name, ownerId: bots.ownerId, model: bots.model, repository: bots.repository })
    if (!row) throw new WorkspaceError('botOwnerOnly')
    return row
  })
  const [policy, repositories, providers] = await Promise.all([modelPolicy(workspaceId), installedRepositories(workspaceId), connectedProviders(actorId, workspaceId)])
  return settingsView(actorId, bot, policy, repositories, providers)
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
