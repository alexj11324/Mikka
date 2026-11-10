// What 设置 › 连接's list receives (docs/ui-overlay.md), and what an app's own page (`&app=`, the optional
// AppPage, on 插件 and 设置 › 连接) receives. The page reads and acts through useConnectedAppPage, useGitHubPlugin
// (with useGitHubAppSetup and useRepositoryVerification), useLinearPlugin and useTelegramPlugin.
import type { ConnectedApps } from '@/components/plugins/connected-apps'
import type { OwnAppsRead } from '@/components/plugins/connected-list'
import type { PluginsGo, PluginsHref } from '@/components/plugins/plugins-view'

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

export type AppPageProps = {
  /** Composio accounts and their actions, from useConnectedApps. */
  apps: ConnectedApps
  /** The app's id: `github`, `linear`, `telegram` or a Composio toolkit. */
  app: string
  /** The 插件 section it was opened from, for the way back. */
  category: string | null
  /** The way back's label: 插件 or 连接. */
  rootLabel: string
  href: PluginsHref
  go: PluginsGo
  /** Linear's OAuth return. */
  linearNotice: 'connected' | 'error' | null
}
