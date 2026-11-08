// What 设置 › 连接's list receives (docs/ui-overlay.md). The app's own page
// (`&app=`) stays the shared one; only the list is drawn by a UI layer.
import type { ConnectedApps } from '@/components/plugins/connected-apps'
import type { OwnAppsRead } from '@/components/plugins/connected-list'

export type SettingsConnectionsProps = {
  /** Composio accounts and their actions (connect, reconnect, turn on/off), from useConnectedApps. */
  apps: ConnectedApps
  /** GitHub, Linear and Telegram connection states. */
  ownRead: OwnAppsRead
  /** An app's page, as a link and in place. */
  href: (id: string) => string
  onOpen: (id: string) => void
  /** Custom MCP servers need a workspace; undefined in a preview. */
  workspaceId?: string
  workspaceName?: string
}
