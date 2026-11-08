// What the panel-header slot receives (docs/ui-overlay.md): the header row of a right column that has no header of
// its own, a bot's 概览 (components/nav/context-panel.tsx) and a group's panel (components/nav/group-panel.tsx).
// The panel keeps the state and the actions; the slot only lays them out.
import type { LucideIcon } from 'lucide-react'

export type PanelHeaderAction = {
  /** Stable name a layer may draw its own icon for (`search`). */
  id: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** A toggle that is on (the search field is open). */
  pressed?: boolean
}

export type PanelHeaderProps = {
  /** Which panel: `context` (概览: its actions, ⤢ and ✕ at the end) or `group` (the title as a pill, then ✕). */
  variant: 'context' | 'group'
  /** What the panel is (概览, 详情). */
  title: string
  /** Secondary actions, in order. */
  actions: PanelHeaderAction[]
  /** ⤢ widens the column, and puts back the width it replaced; absent where it cannot widen (a sheet). */
  widen?: { wide: boolean; onToggle: () => void }
  onClose: () => void
}
