import 'server-only'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, bots, githubRepositoryInstallations, WORKSPACE_BOT_MODELS, workspaceSettings, type WorkspaceBotModel } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'

export interface BotDefaults { defaultModel: WorkspaceBotModel | null; defaultRepository: string | null }
export interface BotDefaultOptions extends BotDefaults {
  /** 'mikka' is Mikka's hosted model; 'codex' / 'claude' use the bot owner's connected subscription. */
  models: readonly WorkspaceBotModel[]
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
  return { ...defaults, models: WORKSPACE_BOT_MODELS, repositories }
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
