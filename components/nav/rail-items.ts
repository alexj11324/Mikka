import type { ComponentType } from 'react'
import type { ChatNavEntry, ChatTarget } from './bot-list'
import { Columns3, House, Lightbulb } from 'lucide-react'
import { ArtifactIcon } from '@/components/icons/artifact-icon'
import { ArtifactFilled, Columns3Filled, HouseFilled, LightbulbFilled, PlugCircle, PlugCircleFilled } from '@/components/icons/rail-filled-icons'

export type RailDestination = 'chats' | 'suggestions' | 'board' | 'plugins' | 'artifacts'

/** A lucide icon or one of ours drawn the same way (components/icons). */
type RailIcon = ComponentType<{ className?: string; 'data-icon'?: string }>

// 主页 (the bot chats), 建议, the board, plugins, Artifact. `selectedIcon` is the solid twin shown on the current item.
export const RAIL_ITEMS: { id: RailDestination; icon: RailIcon; selectedIcon: RailIcon; label: 'Nav.home' | 'Nav.suggestions' | 'Nav.board' | 'Nav.plugins' | 'Nav.artifacts' }[] = [
  { id: 'chats', icon: House, selectedIcon: HouseFilled, label: 'Nav.home' },
  { id: 'suggestions', icon: Lightbulb, selectedIcon: LightbulbFilled, label: 'Nav.suggestions' },
  { id: 'board', icon: Columns3, selectedIcon: Columns3Filled, label: 'Nav.board' },
  { id: 'plugins', icon: PlugCircle, selectedIcon: PlugCircleFilled, label: 'Nav.plugins' },
  { id: 'artifacts', icon: ArtifactIcon, selectedIcon: ArtifactFilled, label: 'Nav.artifacts' },
]

export type RailProps = {
  active: RailDestination | null
  onNavigate: (destination: RailDestination) => void
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
  /** The bot list's rows as data, for a frame that lists them itself (the hosted App Shell); the open-source rail ignores it. */
  chats?: { entries: ChatNavEntry[]; onOpen: (target: ChatTarget) => void }
  /** Opens the ⌘K search, for a frame with its own search field. */
  onSearch?: () => void
}
