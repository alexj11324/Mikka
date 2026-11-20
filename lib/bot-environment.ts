import 'server-only'
import { sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { legacyRepositoryKey } from '@/lib/bot-settings'
import { workspaceDb } from '@/lib/workspace-db'

export interface BotEnvironmentRef {
  workspaceId: string
  environmentId: string | null
  /** Retired column (drizzle/20261120044916): read only when the Bot has no Environment yet. */
  repository: string | null
}

/** A live Environment a Bot can bind, as the New Bot window and Bot profile list it. */
export interface BotEnvironmentOption { id: string; name: string; repositoryKeys: string[] }

const keysOf = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []

/** The repositories of a live Environment in this workspace, or null when it is missing or archived. */
export async function environmentRepositories(workspaceId: string, environmentId: string): Promise<string[] | null> {
  const { rows: [row] } = await workspaceDb.execute<{ repositoryKeys: unknown }>(sql`select configuration->'repositoryKeys' as "repositoryKeys"
    from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId} and "archivedAt" is null`)
  if (!row) return null
  return keysOf(row.repositoryKeys)
}

/** The workspace's live Environments, oldest first: the first is the workspace default (scripts/bot-environment-backfill.mjs). */
export async function botEnvironmentOptions(workspaceId: string): Promise<BotEnvironmentOption[]> {
  const { rows } = await workspaceDb.execute<{ id: string; name: string; repositoryKeys: unknown }>(sql`select id,name,configuration->'repositoryKeys' as "repositoryKeys"
    from workspace_environments where "workspaceId"=${workspaceId} and "archivedAt" is null order by "createdAt",id`)
  return rows.map(row => ({ id: row.id, name: row.name, repositoryKeys: keysOf(row.repositoryKeys) }))
}

/**
 * The Environment a new Bot binds when the person picked none: the oldest one
 * listing `repository` (an older client's 仓库 choice or the workspace's 新 Bot
 * 默认值), else the workspace default. Null in a workspace with no Environment.
 */
export async function defaultBotEnvironment(workspaceId: string, repository?: string | null): Promise<string | null> {
  const options = await botEnvironmentOptions(workspaceId)
  const key = legacyRepositoryKey(repository)
  return (key ? options.find(option => option.repositoryKeys.includes(key)) : undefined)?.id ?? options[0]?.id ?? null
}

/**
 * The repository a Bot's work starts in: its Environment's first repository.
 * A Bot not yet moved to an Environment, or whose Environment is gone, keeps
 * its retired `repository` value until scripts/bot-environment-backfill.mjs runs.
 */
export async function botRepository(bot: BotEnvironmentRef): Promise<string | null> {
  if (bot.environmentId) {
    const keys = await environmentRepositories(bot.workspaceId, bot.environmentId)
    if (keys) return keys[0] ?? null
  }
  return bot.repository
}

/** A writer's check: the Environment must be a live one of this workspace. */
export async function assertBotEnvironment(workspaceId: string, environmentId: string): Promise<void> {
  if (await environmentRepositories(workspaceId, environmentId) === null) throw new ActionFailureError('botEnvironmentUnavailable')
}
