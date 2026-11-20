import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { assertBotEnvironment } from '@/lib/bot-environment'
import { botEffortSchema, botSettingsSchema, type BotDispatchDefaults, type BotRunsOn, type BotSettings, type BotSettingsInput } from '@/lib/bot-settings'
import type { TaskDestination } from '@/lib/task-destination'

type Query = Pick<Pool, 'query'>
export interface BotOwnerScope { ownerId: string; workspaceId: string }

/** Parse, or the one closed code a person sees. */
export function parseBotSettings(input: BotSettingsInput): BotSettings {
  const parsed = botSettingsSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new ActionFailureError(parsed.error.issues[0]?.path[0] === 'alias' ? 'botAliasInvalid' : 'validationGeneric')
}

/**
 * A device the Bot may name: the owner's own local computer, enabled and not
 * removed, with the named Agent on it, while the owner is an active member of
 * this workspace. Devices belong to a person, not a workspace, so membership
 * is what ties one to the workspace.
 */
async function ownDevice(query: Query, owner: BotOwnerScope, deviceId: string, agentId?: string) {
  const { rowCount } = await query.query(`SELECT 1 FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='local' AND d.enabled AND d."removedAt" IS NULL
    AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM agents a WHERE a.id=$3 AND a."userId"=$2 AND a."deviceId"=d.id))`, [deviceId, owner.ownerId, agentId ?? null])
  if (!rowCount) return false
  const { workspaceDb } = await import('@/lib/workspace-db')
  const { workspaceMembers } = await import('@/lib/db/workspace-schema')
  const { and, eq } = await import('drizzle-orm')
  const [member] = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, owner.workspaceId), eq(workspaceMembers.userId, owner.ownerId), eq(workspaceMembers.status, 'active'))).limit(1)
  return Boolean(member)
}

/**
 * Every reference a setting names must belong to the Bot's owner in this
 * workspace: the Environment is live here, a device and its Agent are the
 * owner's, the Agent profile is the owner's and enabled. The client's choice
 * is never trusted.
 */
export async function assertBotSettings(query: Query, owner: BotOwnerScope, settings: BotSettings): Promise<void> {
  if (settings.environmentId) await assertBotEnvironment(owner.ownerId, owner.workspaceId, settings.environmentId)
  const target = settings.crewTarget
  if (target?.kind === 'device' && !await ownDevice(query, owner, target.deviceId, target.agentId)) throw new ActionFailureError('botTargetUnavailable')
  if (settings.runsOn?.kind === 'device' && !await ownDevice(query, owner, settings.runsOn.deviceId)) throw new ActionFailureError('botTargetUnavailable')
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

/** The Bot Profile's settings, for its owner. */
export interface OwnedBotSettings {
  alias: string | null
  environmentId: string | null
  crewTarget: TaskDestination | null
  defaultAgent: 'claude_code' | 'codex' | null
  defaultProfileId: string | null
  runsOn: BotRunsOn | null
  effort: import('@/lib/model-routing').ModelRoutingEffort | null
}

/** Null for a Bot that is not the owner's here. */
export async function readOwnedBotSettings(query: Query, owner: BotOwnerScope, botId: string): Promise<OwnedBotSettings | null> {
  if (!z.uuid().safeParse(botId).success) return null
  const { rows: [row] } = await query.query<OwnedBotSettings>(`SELECT b.alias,b."environmentId",b."crewTarget",b."defaultAgent",b."defaultProfileId",b."runsOn",c.effort
    FROM bots b LEFT JOIN bot_model_choices c ON c."ownerId"=b."ownerId" AND c."workspaceId"=b."workspaceId" AND c."botKey"=b.id::text
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3`, [botId, owner.ownerId, owner.workspaceId])
  return row ?? null
}

/**
 * The reasoning effort of the Bot's chat model (New Bot's Model + effort);
 * null is the model's default. Kept beside the model choice, which it leaves as it is.
 */
export async function setBotModelEffort(owner: BotOwnerScope, botId: string, effort: string | null): Promise<void> {
  if (!z.uuid().safeParse(botId).success) throw new ActionFailureError('botNotFound')
  const parsed = botEffortSchema.nullable().safeParse(effort)
  if (!parsed.success) throw new ActionFailureError('validationGeneric')
  // Through `db`, so a caller's open transaction (a Bot create or PATCH) carries it.
  const [{ db }, { sql }] = await Promise.all([import('@/lib/db'), import('drizzle-orm')])
  const { rowCount } = await db.execute(sql`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey",effort)
    SELECT "ownerId","workspaceId",id::text,${parsed.data} FROM bots WHERE id=${botId}::uuid AND "ownerId"=${owner.ownerId} AND "workspaceId"=${owner.workspaceId}::uuid AND "archivedAt" IS NULL
    ON CONFLICT ("ownerId","workspaceId","botKey") DO UPDATE SET effort=EXCLUDED.effort`)
  if (!rowCount) throw new ActionFailureError('botNotFound')
}
