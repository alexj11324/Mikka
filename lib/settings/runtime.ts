import 'server-only'
import type { ResolvedSetting, SettingScope } from '@mikka/protocol/settings'
import { personalSettingWorkspace, resolveSettingValue, SETTINGS_REGISTRY, type SettingKey, type SettingValueFor } from './registry'
import { unpackSettingValue, type StoredSettingValue } from './stored-value'

type Query = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

/** Runtime callers must already hold their workspace admission; use their current database/transaction. */
export async function readRuntimeSetting<K extends SettingKey>(database: Query, key: K, context: { userId: string; workspaceId: string }): Promise<ResolvedSetting<SettingValueFor<K>>> {
  const field = SETTINGS_REGISTRY[key]
  const { rows } = await database.query(`SELECT 'personal' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM personal_setting_values WHERE "userId"=$1 AND "workspaceId" IS NOT DISTINCT FROM $3::uuid AND key=$4
    UNION ALL SELECT 'workspace' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM workspace_setting_values WHERE "workspaceId"=$2 AND key=$4`,
  [context.userId, context.workspaceId, personalSettingWorkspace(field, context.workspaceId), key])
  const value = (scope: SettingScope) => unpackSettingValue(rows.find(row => row.scope === scope) as StoredSettingValue | undefined)
  return resolveSettingValue(key, value('personal'), value('workspace')) as ResolvedSetting<SettingValueFor<K>>
}
