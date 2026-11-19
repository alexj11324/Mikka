import type { ComponentType } from 'react'
import type { ChatNavEntry, ChatTarget } from './bot-list'
import type { WorkspacePage } from '@/components/workspace/page-loaders'
import { CalendarClock, Columns3, GitPullRequest, House, Lightbulb } from '@/components/icons'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactFilled, Columns3Filled, HouseFilled, LightbulbFilled, PlugCircle, PlugCircleFilled } from '@/components/icons/rail-filled-icons'

export type RailDestination = 'chats' | 'pulls' | 'automations' | 'suggestions' | 'board' | 'plugins' | 'artifacts'

/** A lucide icon or one of ours drawn the same way (components/icons). */
type RailIcon = ComponentType<{ className?: string; 'data-icon'?: string }>

// 主页 (the bot chats), 建议, 任务 (one entry; 看板 and 列表 are its views, 2026-11-17-1500), plugins, Artifact. `selectedIcon` is the solid twin shown on the current item.
export const RAIL_ITEMS: { id: RailDestination; icon: RailIcon; selectedIcon: RailIcon; label: 'ArtifactsPage.category.pullRequests' | 'Nav.conversations' | 'Nav.suggestions' | 'Nav.tasks' | 'Nav.plugins' | 'Nav.artifacts' | 'Nav.automation' }[] = [
  { id: 'chats', icon: House, selectedIcon: HouseFilled, label: 'Nav.conversations' },
  { id: 'suggestions', icon: Lightbulb, selectedIcon: LightbulbFilled, label: 'Nav.suggestions' },
  { id: 'pulls', icon: GitPullRequest, selectedIcon: GitPullRequest, label: 'ArtifactsPage.category.pullRequests' },
  // 自动化已是一整套功能 (components/automations, app/actions/automations.ts, the
  // trigger webhooks) and reachable at `?section=automations`, but it had no way
  // in from the rail — the one thing missing was this row.
  { id: 'automations', icon: CalendarClock, selectedIcon: CalendarClock, label: 'Nav.automation' },
  { id: 'board', icon: Columns3, selectedIcon: Columns3Filled, label: 'Nav.tasks' },
  { id: 'plugins', icon: PlugCircle, selectedIcon: PlugCircleFilled, label: 'Nav.plugins' },
  { id: 'artifacts', icon: ArtifactIcon, selectedIcon: ArtifactFilled, label: 'Nav.artifacts' },
]

export type RailProps = {
  active: RailDestination | null
  onNavigate: (destination: RailDestination) => void
  onPageIntent?: (page: WorkspacePage) => void
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
  /** The bot list's rows as data, for a frame that lists them itself (the hosted App Shell); the open-source rail ignores it. */
  chats?: { workspaceId: string | null; entries: ChatNavEntry[]; /** The person's archived bots (已归档): they open nothing; their menu restores or deletes them. */ archived?: ChatNavEntry[]; /** Chats the person hid (已隐藏): they open as usual; their menu shows them again. */ hidden?: ChatNavEntry[]; onOpen: (target: ChatTarget) => void; onNewBot: () => void; onNewGroup: () => void; onNewConversation?: () => void }
  /** Opens the ⌘K search, for a frame with its own search field. */
  onSearch?: () => void
  /** How many items 收件箱 lists (hooks/use-inbox-count.ts), for a frame that shows the count on it. */
  inboxCount?: number
}
