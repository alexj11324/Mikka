// What 看板's columns and cards receive (docs/ui-overlay.md). The board itself,
// drag and drop, the card's context menu, its controls (status, priority,
// assignee, labels, PRs) and every save stay in KanbanBoard / IssueBoard; a layer
// arranges and styles the pieces it is handed. Opening a task stays a full page
// (R-82). The right-hand panel and the top bar are not part of this slot.
import type { ComponentType, ReactNode } from 'react'
import type { AgentState, BoardColumn } from '@/components/blocks/kanban-board-1/components/data'
import type { BlockReason } from '@/lib/task-blocked'

export type BoardColumnFrameProps = {
  status: BoardColumn
  /** The column's translated name. */
  label: string
  /** The status icon as Mikka draws it, already tinted. */
  icon: ReactNode
  count: number
  /** The column's ⋯ menu (隐藏此列). */
  menu: ReactNode
  /** The column's droppable list of cards; render it as given. */
  children: ReactNode
}

export type BoardHiddenLaneProps = {
  /** 已隐藏, translated. */
  label: string
  /** One per hidden column: its icon, name, count and the action that shows it again. */
  columns: Array<{ status: BoardColumn; label: string; icon: ComponentType<{ className?: string }>; iconClassName?: string; count: number; title: string; onShow: () => void }>
}

export type BoardCardProps = {
  /** The task's id; stable across renders. */
  id: string
  /** As shown: the display title. */
  title: string
  /** The full title, for a tooltip. */
  fullTitle: string
  /** The task number (`ALEX-12`), when the property is on and the task has one. */
  identifier: string | null
  /** Done, canceled or duplicate: a quieter title. */
  done: boolean
  /** The lock for a personal task, with its tooltip; null for a workspace task. */
  personal: ReactNode
  /** The status menu (an icon button); its click never opens the task. */
  status: ReactNode
  /** The assignee control with the avatar group; null when the property is off. */
  assignee: ReactNode
  /** Whether anyone owns the task; without an owner the control shows on hover and focus only. */
  hasAssignee: boolean
  /** The third row: priority, labels, project, PR, subtasks, 受阻, agent state, due date; only what the task has. The agent state's chip has the key `agent` and the 受阻 chip the key `block`, so a layer that draws `runState` or `block` itself can leave them out. */
  chips: ReactNode[]
  /** The current attempt's state when the 智能体状态 property is on (R-52): running, waiting for the person, or blocked on them; null for none. */
  runState: AgentState | null
  /** Why the task sits in 受阻, with the words its chip shows (等你回答, 额度用完, 失败…); null when it is not blocked. */
  block: { reason: BlockReason; label: string } | null
  /** 创建于 …, when the property is on. */
  createdAt: ReactNode
  /** The drag preview: tilted, no hover. */
  overlay: boolean
  /** Off-card editors the context menu opens; render as given, hidden. */
  editors: ReactNode
}
