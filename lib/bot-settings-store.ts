import 'server-only'
import type { Pool } from 'pg'
import { ActionFailureError } from '@/lib/action-error'
import { assertBotEnvironment } from '@/lib/bot-environment'
import { botSettingsSchema, type BotDispatchDefaults, type BotRunsOn, type BotSettings, type BotSettingsInput } from '@/lib/bot-settings'
import type { TaskDestination } from '@/lib/task-destination'

type Query = Pick<Pool, 'query'>
export interface BotOwnerScope { ownerId: string; workspaceId: string }

/** Parse, or the one closed code a person sees. */
export function parseBotSettings(input: BotSettingsInput): BotSettings {
  const parsed = botSettingsSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'alias' ? 'botAliasInvalid' : 'validationGeneric')
}

async function ownDevice(query: Query, ownerId: string, deviceId: string, agentId?: string) {
  const { rowCount } = await query.query(`SELECT 1 FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='local'
    AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM agents a WHERE a.id=$3 AND a."userId"=$2 AND a."deviceId"=d.id))`, [deviceId, ownerId, agentId ?? null])
  return Boolean(rowCount)
}

/**
 * Every reference a setting names must belong to the Bot's owner in this
 * workspace: the Environment is live here, a device and its Agent are the
 * owner's, the Agent profile is the owner's and enabled. The client's choice
 * is never trusted.
 */
export async function assertBotSettings(query: Query, owner: BotOwnerScope, settings: BotSettings): Promise<void> {
  if (settings.environmentId) await assertBotEnvironment(owner.workspaceId, settings.environmentId)
  const target = settings.crewTarget
  if (target?.kind === 'device' && !await ownDevice(query, owner.ownerId, target.deviceId, target.agentId)) throw new ActionFailureError('botTargetUnavailable')
  if (settings.runsOn?.kind === 'device' && !await ownDevice(query, owner.ownerId, settings.runsOn.deviceId)) throw new ActionFailureError('botTargetUnavailable')
  if (settings.defaultProfileId) {
    const { readProfileRow } = await import('@/lib/factory/agent-profile-store')
    const profile = await readProfileRow(query, owner, settings.defaultProfileId).catch(() => null)
    if (!profile || profile.archivedAt || !profile.definition?.enabled) throw new ActionFailureError('botTargetUnavailable')
  }
}

/** The columns a parsed setting writes; undefined fields are left out. */
export function botSettingsColumns(settings: BotSettings): Partial<{ alias: string | null; environmentId: string | null; crewTarget: TaskDestination | null;
  defaultAgent: 'claude_code' | 'codex' | null; defaultProfileId: string | null; runsOn: BotRunsOn | null }> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
}

/** A unique violation on the alias index, as opposed to the per-owner name index. */
export function aliasConflict(error: unknown): boolean {
  const failure = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }
  const code = failure.code ?? failure.cause?.code
  const constraint = failure.constraint ?? failure.cause?.constraint
  return code === '23505' && constraint === 'bots_workspace_alias_key'
}

/** The Bot's own dispatch defaults, read by the dispatcher (workflows/coordinator/steps.ts). Null for a Bot that does not exist. */
export async function botDispatchDefaults(query: Query, botId: string): Promise<BotDispatchDefaults | null> {
  const { rows: [row] } = await query.query<BotDispatchDefaults & { workspaceId: string; environmentId: string | null; legacyRepository: string | null }>(
    `SELECT "workspaceId","environmentId",repository AS "legacyRepository","crewTarget","defaultAgent","defaultProfileId" FROM bots WHERE id=$1`, [botId])
  if (!row) return null
  const { botRepository } = await import('@/lib/bot-environment')
  return { crewTarget: row.crewTarget ?? null, defaultAgent: row.defaultAgent ?? null, defaultProfileId: row.defaultProfileId ?? null,
    repository: await botRepository({ workspaceId: row.workspaceId, environmentId: row.environmentId, repository: row.legacyRepository }) }
}
