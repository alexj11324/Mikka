import type { AppPageProps, SettingsConnectionsProps } from './settings-connections-contract'

/** Runtime renderers come from the official provider. */
export function ConnectionsList(_props: SettingsConnectionsProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: settings-connections')
}
export function AppPage(_props: AppPageProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: settings-connections')
}
