import 'server-only'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { ResolvedSetting, SettingScope, SettingValue, SettingsView } from '@mikka/protocol/settings'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { threadDirectorySettingsChanged, workspaceListChanged } from '@/lib/live/lists'
import { wakeTokens, wakeWorkflowAfterCommit } from '@/lib/workflow-wake'
import { mirrorLegacySetting } from './legacy-mirrors'
import { SETTINGS_REGISTRY, parseSettingsPatch, personalSettingWorkspace, resolveSettingValue, settingDefinition, settingsResetInput, type SettingDefinition } from './registry'
import { personalSettingValues, workspaceSettingValues } from './schema'
import { unpackSettingValue, type StoredSettingValue } from './stored-value'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
export interface SettingsContext { userId: string; workspaceId: string }
function pack(field: SettingDefinition, raw: SettingValue | null): StoredSettingValue {
  const row: StoredSettingValue = { booleanValue: null, integerValue: null, textValue: null, textArrayValue: null }
  if (raw === null) return row
  const value = field.guard.parse(raw)
  if (typeof value === 'boolean') row.booleanValue = value
  else if (typeof value === 'number') row.integerValue = value
  else if (typeof value === 'string') row.textValue = value
  else row.textArrayValue = value
  return row
}

async function readValues(context: SettingsContext, database: Reader = db, scope: SettingScope = 'personal'): Promise<SettingsView> {
  const personal = await database.select().from(personalSettingValues).where(and(eq(personalSettingValues.userId, context.userId),
    or(isNull(personalSettingValues.workspaceId), eq(personalSettingValues.workspaceId, context.workspaceId))))
  const workspace = await database.select().from(workspaceSettingValues).where(eq(workspaceSettingValues.workspaceId, context.workspaceId))
  const values = Object.fromEntries(Object.values(SETTINGS_REGISTRY).map((field: SettingDefinition) => {
    const own = personal.find(row => row.key === field.key && row.workspaceId === personalSettingWorkspace(field, context.workspaceId))
    return [field.key, resolveSettingValue(field.key, scope === 'personal' ? unpackSettingValue(own) : null, unpackSettingValue(workspace.find(row => row.key === field.key)))]
  }))
  return { workspaceId: context.workspaceId, values }
}

/** Both API reads and background consumers re-admit the explicit workspace. */
export async function readSettings(context: SettingsContext, scope: SettingScope = 'personal'): Promise<SettingsView> {
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, context.workspaceId, context.userId)
    return readValues(context, db, scope)
  })
}

export async function resolveSetting(key: string, context: SettingsContext): Promise<ResolvedSetting> {
  settingDefinition(key)
  return (await readSettings(context)).values[key]!
}

async function writeRows(tx: Transaction, scope: SettingScope, context: SettingsContext, values: Record<string, SettingValue | null>) {
  for (const [key, value] of Object.entries(values)) {
    const field = settingDefinition(key)
    const changed = { ...pack(field, value), updatedAt: new Date() }
    if (scope === 'personal') {
      await tx.insert(personalSettingValues).values({ userId: context.userId,
        workspaceId: personalSettingWorkspace(field, context.workspaceId), key, ...changed })
        .onConflictDoUpdate({ target: [personalSettingValues.userId, personalSettingValues.workspaceId, personalSettingValues.key], set: changed })
    } else {
      await tx.insert(workspaceSettingValues).values({ workspaceId: context.workspaceId, key, ...changed })
        .onConflictDoUpdate({ target: [workspaceSettingValues.workspaceId, workspaceSettingValues.key], set: changed })
    }
    await mirrorLegacySetting(key)?.(tx, scope, context, value)
  }
  if (Object.hasOwn(values, 'keepPinnedThreadsActive') || scope === 'workspace' && Object.hasOwn(values, 'archiveIdleAfterDays')) {
    await threadDirectorySettingsChanged(tx, context.workspaceId, scope === 'personal' ? context.userId : undefined)
  }
  if (scope === 'workspace' && Object.hasOwn(values, 'subagentMaxConcurrent')) {
    // Raising capacity wakes the existing waiting workflows after commit; no new polling loop.
    const limit = Number(values.subagentMaxConcurrent ?? SETTINGS_REGISTRY.subagentMaxConcurrent.defaultValue)
    const { rows } = await tx.execute<{ id: string }>(sql`SELECT id FROM (
      SELECT id,row_number() OVER (PARTITION BY "ownerId" ORDER BY "createdAt",id) AS position
      FROM bot_subagents WHERE "workspaceId"=${context.workspaceId} AND status='queued'
    ) waiting WHERE position<=${limit}`)
    for (const { id } of rows) wakeWorkflowAfterCommit(tx, wakeTokens.subagent(id))
  }
}

/** Membership/role stays locked through the app-data commit; the caller cannot supply a different target user. */
export async function writeSettings(context: SettingsContext, scope: SettingScope, raw: unknown): Promise<SettingsView> {
  const values = parseSettingsPatch(scope, raw)
  return workspaceDb.transaction(async workspaceTx => {
    await requireWorkspace(workspaceTx, context.workspaceId, context.userId, scope === 'workspace')
    const result = await db.transaction(async tx => {
      if (scope === 'personal') await tx.select({ id: users.id }).from(users).where(eq(users.id, context.userId)).for('no key update')
      await writeRows(tx, scope, context, values)
      return readValues(context, tx, scope)
    })
    await workspaceListChanged(workspaceTx, context.workspaceId, ['workspace_settings'])
    return result
  })
}

export async function resetSettings(context: SettingsContext, scope: SettingScope, raw: unknown): Promise<SettingsView> {
  const { group } = settingsResetInput.parse(raw)
  const values = Object.fromEntries(Object.values(SETTINGS_REGISTRY).filter((field: SettingDefinition) => field.group === group && field.scope.includes(scope))
    .map(field => [field.key, null]))
  return writeSettings(context, scope, { values })
}
