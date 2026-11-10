'use client'

import type { ComponentType } from 'react'
import type { AppPageProps } from './settings-connections-contract'

/**
 * 设置 › 连接's list: what the person has connected (decision 2026-10-31).
 * The open-source UI draws the shared list; a UI layer may draw its own from
 * the same props (docs/ui-overlay.md).
 */
export { ConnectedList as ConnectionsList } from '@/components/plugins/connected-list'

/** An app's own page (`&app=`), on 插件 and 设置 › 连接: none here, so the shared PluginAppPage draws it. Optional. */
export const AppPage: ComponentType<AppPageProps> | null = null
