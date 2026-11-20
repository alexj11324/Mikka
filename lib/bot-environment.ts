import 'server-only'
import { sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { workspaceDb } from '@/lib/workspace-db'

export interface BotEnvironmentRef {
  workspaceId: string
  environmentId: string | null
  /** Retired column (drizzle/20261120044916): read only when the Bot has no Environment yet. */
  repository: string | null
}

/** The repositories of a live Environment in this workspace, or null when it is missing or archived. */
export async function environmentRepositories(workspaceId: string, environmentId: string): Promise<string[] | null> {
  const { rows: [row] } = await workspaceDb.execute<{ repositoryKeys: unknown }>(sql`select configuration->'repositoryKeys' as "repositoryKeys"
    from workspace_environments where id=${environmentId} and "workspaceId"=${workspaceId} and "archivedAt" is null`)
  if (!row) return null
  return Array.isArray(row.repositoryKeys) ? row.repositoryKeys.filter((key): key is string => typeof key === 'string') : []
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
