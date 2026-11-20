import 'server-only'
import type { ResolvedSetting, SettingValue } from '@mikka/protocol/settings'
import { resolveSettingValue, settingDefinition } from './registry'

type Query = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }

/** Runtime callers must already hold their workspace admission; use their current database/transaction. */
export async function readRuntimeSetting(database: Query, key: string, context: { userId: string; workspaceId: string }): Promise<ResolvedSetting> {
  const field = settingDefinition(key)
  const { rows } = await database.query(`SELECT 'personal' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM personal_setting_values WHERE "userId"=$1 AND "workspaceId" IS NOT DISTINCT FROM $3::uuid AND key=$4
    UNION ALL SELECT 'workspace' AS scope,"booleanValue","integerValue","textValue","textArrayValue"
    FROM workspace_setting_values WHERE "workspaceId"=$2 AND key=$4`,
  [context.userId, context.workspaceId, field.personalContext === 'workspace' ? context.workspaceId : null, key])
  const value = (scope: string) => {
    const row = rows.find(row => row.scope === scope)
    return (row?.booleanValue ?? row?.integerValue ?? row?.textValue ?? row?.textArrayValue ?? null) as SettingValue | null
  }
  return resolveSettingValue(key, value('personal'), value('workspace'))
}
