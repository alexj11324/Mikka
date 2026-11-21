import type { SettingsPermissionsProps } from './settings-permissions-contract'

/** Type contract for public tooling. Official clients link the provider at build time. */
export function TeamPermissionsPage(_props: SettingsPermissionsProps): never {
  throw new Error('UI_SLOT_REQUIRES_OFFICIAL_CLIENT: settings-permissions')
}
