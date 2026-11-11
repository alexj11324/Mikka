// The default settings-permissions slot (docs/ui-overlay.md): none. 团队权限
// draws its own rows (TeamPermissionsSettings); a layer that draws the page
// exports `TeamPermissionsPage` here and gets each policy's state and save.
import type { ComponentType } from 'react'
import type { SettingsPermissionsProps } from './settings-permissions-contract'

export const TeamPermissionsPage: ComponentType<SettingsPermissionsProps> | null = null
