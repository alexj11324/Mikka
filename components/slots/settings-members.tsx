import type { SettingsMembersProps } from './settings-members-contract'

/** Official Web and Desktop resolve this component from the required provider. */
export function MembersScreen(_props: SettingsMembersProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: settings-members')
}
