import type { ComponentType } from 'react'
import type { SettingsMembersProps } from '@/components/slots/settings-members-contract'

/**
 * 设置 › 成员 as one screen. The open-source UI keeps MembersSettings (and the
 * hosted governance card above it), so it draws nothing here; a layer that
 * draws the whole page exports a component.
 */
export const MembersScreen: ComponentType<SettingsMembersProps> | null = null
