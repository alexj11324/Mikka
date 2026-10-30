import 'server-only'
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, githubRepositoryInstallations, WORKSPACE_BOT_MODELS, workspaceSettings, type WorkspaceBotModel } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'

export interface BotDefaults { defaultModel: WorkspaceBotModel | null; defaultRepository: string | null }
/** BotDefaults plus the optimistic-lock version a save must echo back as expectedVersion. */
export interface VersionedBotDefaults extends BotDefaults { version: number }
export interface BotDefaultOptions extends VersionedBotDefaults {
  /** 'mikka' is Mikka's hosted model; 'codex' / 'claude' use the bot owner's connected subscription. */
  models: readonly WorkspaceBotModel[]
  /** owner/repo remote keys from the GitHub App installations of the workspace's active members. */
  repositories: string[]
}

export const botDefaultsInput = z.object({
  defaultModel: z.enum(WORKSPACE_BOT_MODELS).nullable().optional(),
  defaultRepository: z.string().trim().min(1).max(300).nullable().optional(),
  /** Version the client last read; omitted = last write wins (old clients). */
  expectedVersion: z.number().int().min(0).optional(),
}).strict()

/** expectedVersion no longer matches: someone else saved first. Carries the current value. */
export class BotDefaultsConflictError extends WorkspaceError {
  constructor(readonly current: VersionedBotDefaults) { super('botDefaultsConflict') }
}

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
  const { version: _version, ...defaults } = await versionedBotDefaults(workspaceId)
  return defaults
}

async function versionedBotDefaults(workspaceId: string): Promise<VersionedBotDefaults> {
  const [row] = await db.select({ defaultModel: workspaceSettings.defaultModel, defaultRepository: workspaceSettings.defaultRepository, version: workspaceSettings.botDefaultsVersion })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1)
  return { defaultModel: row?.defaultModel ?? null, defaultRepository: row?.defaultRepository ?? null, version: row?.version ?? 0 }
}

/** 新 Bot 默认值 and what can be chosen. Any active member may read them. */
export async function botDefaultOptions(workspaceId: string): Promise<BotDefaultOptions> {
  const [defaults, repositories] = await Promise.all([versionedBotDefaults(workspaceId), installedRepositories(workspaceId)])
  return { ...defaults, models: WORKSPACE_BOT_MODELS, repositories }
}

/**
 * Admins only. A repository must be installed by an active member; null clears a default.
 * With expectedVersion the write is a compare-and-set on botDefaultsVersion (one UPDATE ... WHERE,
 * atomic under concurrency); a stale version throws BotDefaultsConflictError with the current value.
 */
export async function saveBotDefaults(actorId: string, workspaceId: string, input: z.input<typeof botDefaultsInput>): Promise<VersionedBotDefaults> {
  const { expectedVersion, ...values } = botDefaultsInput.parse(input)
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true)
    if (values.defaultRepository && !(await repositoryAvailable(workspaceId, values.defaultRepository))) {
      throw new WorkspaceError('botDefaultRepositoryUnavailable')
    }
    // Make sure the row exists (version 0), then compare-and-set in a single statement.
    await db.insert(workspaceSettings).values({ workspaceId }).onConflictDoNothing({ target: workspaceSettings.workspaceId })
    const match = expectedVersion === undefined
      ? eq(workspaceSettings.workspaceId, workspaceId)
      : and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.botDefaultsVersion, expectedVersion))
    const [row] = await db.update(workspaceSettings)
      .set({ ...values, botDefaultsVersion: sql`${workspaceSettings.botDefaultsVersion} + 1`, updatedAt: new Date() })
      .where(match)
      .returning({ defaultModel: workspaceSettings.defaultModel, defaultRepository: workspaceSettings.defaultRepository, version: workspaceSettings.botDefaultsVersion })
    if (!row) throw new BotDefaultsConflictError(await versionedBotDefaults(workspaceId))
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
