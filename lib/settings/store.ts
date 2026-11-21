import 'server-only'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { ResolvedSetting, SettingScope, SettingValue, SettingsView } from '@mikka/protocol/settings'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { workspaceListChanged } from '@/lib/live/lists'
import { mirrorLegacySetting } from './legacy-mirrors'
import { SETTINGS_REGISTRY, parseSettingsPatch, resolveSettingValue, settingDefinition, settingsResetInput, type SettingDefinition } from './registry'
import { personalSettingValues, workspaceSettingValues } from './schema'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
export interface SettingsContext { userId: string; workspaceId: string }
type StoredValue = Pick<typeof personalSettingValues.$inferSelect, 'booleanValue' | 'integerValue' | 'textValue' | 'textArrayValue'>

function unpack(row: StoredValue | undefined): SettingValue | null {
  return row?.booleanValue ?? row?.integerValue ?? row?.textValue ?? row?.textArrayValue ?? null
}

function pack(field: SettingDefinition, raw: SettingValue | null): StoredValue {
  const row: StoredValue = { booleanValue: null, integerValue: null, textValue: null, textArrayValue: null }
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
    const own = personal.find(row => row.key === field.key && row.workspaceId === (field.personalContext === 'workspace' ? context.workspaceId : null))
    return [field.key, resolveSettingValue(field.key, scope === 'personal' ? unpack(own) : null, unpack(workspace.find(row => row.key === field.key)))]
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
        workspaceId: field.personalContext === 'workspace' ? context.workspaceId : null, key, ...changed })
        .onConflictDoUpdate({ target: [personalSettingValues.userId, personalSettingValues.workspaceId, personalSettingValues.key], set: changed })
    } else {
      await tx.insert(workspaceSettingValues).values({ workspaceId: context.workspaceId, key, ...changed })
        .onConflictDoUpdate({ target: [workspaceSettingValues.workspaceId, workspaceSettingValues.key], set: changed })
    }
    await mirrorLegacySetting(key)?.(tx, scope, context, value)
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
