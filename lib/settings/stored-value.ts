import type { SettingValue } from '@mikka/protocol/settings'
import type { personalSettingValues } from './schema'

export type StoredSettingValue = Pick<typeof personalSettingValues.$inferSelect, 'booleanValue' | 'integerValue' | 'textValue' | 'textArrayValue'>

export function unpackSettingValue(row: StoredSettingValue | undefined): SettingValue | null {
  return row?.booleanValue ?? row?.integerValue ?? row?.textValue ?? row?.textArrayValue ?? null
}
