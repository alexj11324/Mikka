'use client'

/**
 * 设置 › 应用与运行权限's page: the current workspace's access level per connected
 * app; every Bot in the workspace inherits it. There is no per-Bot permission
 * layer. The open-source UI draws the shared page; a UI layer may
 * draw its own from the same props (docs/ui-overlay.md).
 */
export { BotPermissionsView as BotPermissionsPage } from '@/components/settings/bot-permissions'
