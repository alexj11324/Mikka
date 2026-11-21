/** Shared settings contract. Clients never import the server registry or storage. */
export type SettingSource = 'personal' | 'workspace' | 'default'
export type SettingScope = 'personal' | 'workspace'
export type SettingValue = string | number | boolean | string[]

export interface ResolvedSetting<T extends SettingValue = SettingValue> {
  value: T
  source: SettingSource
}

export interface SettingSchemaEntry {
  key: string
  scope: SettingScope[]
  group: string
  page: string
  label: { en: string; 'zh-CN': string }
  keywords: string[]
  type: 'boolean' | 'integer' | 'string' | 'string-array'
  defaultValue: SettingValue
  personalOverride: boolean
  writeAccess: { personal?: 'owner'; workspace?: 'admin' }
  options?: SettingValue[]
}

export interface SettingsView {
  workspaceId: string
  values: Record<string, ResolvedSetting>
}

export interface SettingsPatch {
  values: Record<string, SettingValue | null>
}
