// What the settings sidebar slot receives (docs/ui-overlay.md). The default
// (components/slots/settings-sidebar.tsx) and a layer's slots/settings-sidebar.tsx
// both implement `SettingsSidebar`; callers import from
// @/components/settings/settings-sidebar only.
import type { RailDestination } from '@/components/nav/icon-rail'
import type { SettingsSectionId } from '@/lib/settings-sections'

export type SettingsSidebarProps = {
  section: SettingsSectionId
  activeSection?: SettingsSectionId
  /** Viewer is a workspace admin. Admin-only sections stay hidden until this is known (S-P). */
  admin: boolean
  /** Not (yet) known to be a team workspace: only the account group, 用量 and 计费 (decision 2026-11-01-2310). */
  personal?: boolean
  billing?: boolean
  /** The second group is named after the current workspace. */
  workspaceName?: string
  selectedTeamId?: string
  workspaceId?: string
  onSectionChange: (section: SettingsSectionId) => void
  /** A pointer or focus on an item: time to fetch its section. */
  onIntent?: (section: SettingsSectionId) => void
  onRail: (destination: RailDestination) => void
}
