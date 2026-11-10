// What the task-detail slot receives (docs/ui-overlay.md): a task's page as data and actions. The layer draws the
// whole page (bar, title, description, sub-tasks, activity, details) with its own controls; every save, read and
// rule stays in public code (components/workspace/task-detail.tsx and task-detail-frame.tsx). The description editor,
// 验收, an open thread and the dialogs stay Mikka's and come in rendered.
import { createContext, type CompositionEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { IssueDetailNavigation } from '@/components/workspace/issue-detail-header'
import type { IssueDiscussions } from '@/components/workspace/issue-editor'
import type { TaskReason, TaskState } from '@/hooks/use-bot-tasks'

/** A glyph the layer draws from its own set. */
export type TaskIcon =
  | 'status' | 'priority' | 'person' | 'project' | 'tag' | 'team' | 'workspace' | 'personal' | 'calendar' | 'estimate'
  | 'link' | 'pullRequest' | 'parent' | 'flag' | 'copy' | 'newTab' | 'star' | 'bell' | 'bellOff' | 'history'
  | 'members' | 'document' | 'delete' | 'plus' | 'listPlus' | 'remove' | 'mail' | 'open'

/** What goes in front of a value or a menu item. */
export type TaskMark =
  /** One of Mikka's statuses (backlog, todo, doing, review, done, canceled, duplicate). */
  | { kind: 'status'; value: string }
  /** One of Mikka's priorities (urgent, high, normal, low); none draws nothing. */
  | { kind: 'priority'; value: string }
  /** A person, by name (initials). */
  | { kind: 'person'; name: string }
  | { kind: 'icon'; icon: TaskIcon }
  /** A mark only Mikka draws: a Bot's own look (R-36), an Agent's harness. */
  | { kind: 'node'; node: ReactNode }

export type TaskMenuItem = {
  id: string
  label: string
  description?: string
  mark?: TaskMark
  checked?: boolean
  danger?: boolean
  /** A line above this item. */
  divider?: boolean
  submenu?: TaskMenuItem[]
  /** Absent: a line that only informs (loading, nothing to pick). */
  onSelect?: () => void
}

/** A chip in a details row (labels, PRs, related tasks). */
export type TaskChip = {
  id: string
  text: string
  mark?: TaskMark
  title?: string
  /** Opens in a new tab. */
  href?: string
  /** A PR's live GitHub state: `draw` gets the words to show while GitHub answers. */
  live?: (draw: (view: { text: string; title: string; state: string; confirmed: boolean }) => ReactNode) => ReactNode
  /** The chip opens these choices. */
  menu?: TaskMenuItem[]
}

/** One line of the details card: a label, then its value, chips or both. */
export type TaskDetailRow = {
  id: string
  label: string
  value?: { text: string; mark?: TaskMark; muted?: boolean; danger?: boolean; title?: string; aria?: string }
  /** The value opens these choices. */
  menu?: TaskMenuItem[]
  /** Called when the menu or the add button opens, to read the choices. */
  onOpen?: () => void
  /** The value opens one of Mikka's dialogs instead. */
  onClick?: () => void
  chips?: TaskChip[]
  /** The + after the chips. */
  add?: { label: string; menu?: TaskMenuItem[]; onClick?: () => void }
  /** A quiet word after the value (自动判断). */
  note?: string
  disabled?: boolean
  /**
   * The status row only: the task's own state (localTaskState on its newest thread, decision #1864 point 6), which the
   * value shows instead of the board status, as every other surface names the task; `menu` still sets the board status.
   */
  state?: { state: TaskState; reason: TaskReason | null }
}

export type TaskSubtask = {
  id: string
  identifier: string | null
  title: string
  done: boolean
  statusLabel: string
  /** Ticks it done, or back to 待办. */
  onToggle: () => void
  onOpen: () => void
  /** Status choices and removing it from this task. */
  menu: TaskMenuItem[]
}

export type TaskActivityItem =
  | { kind: 'event'; id: string; at: string; who: string | null; mark?: TaskMark; text: string; time: string }
  /** An Agent's stretch of runs (R-62): opens the task's conversation at its first thread. */
  | { kind: 'agent'; id: string; at: string; who: string; mark: TaskMark; text: string; time: string; open: boolean; onOpen: (() => void) | null; openLabel: string }
  | { kind: 'comment'; id: string; at: string; thread: IssueDiscussions['threads'][number]; excerpt: string | null; time: (at: string) => string }

export type TaskDetailFrameProps = {
  rootRef: RefObject<HTMLDivElement | null>
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  /** The page's accessible name: the title, or the title field's label while it is empty. */
  label: string
  busy: boolean
  /** Where the task was opened from (a bot's chat, 看板, a project): the first crumb, which goes back there, as close does. */
  origin: string
  identifier: string | null
  title: string
  /** 已自动保存 / 正在保存… / 保存失败; empty while nothing can be saved. */
  saveLabel: string
  saved: boolean
  saveHint: string
  navigation: IssueDetailNavigation
  onClose: () => void
  words: { previous: string; next: string; close: string; more: string; details: string; subtasks: string; subtaskPlaceholder: string; addSubtask: string; subtaskMenu: (title: string) => string; activity: string; comment: string; commentPlaceholder: string; send: string; reply: string; replyPlaceholder: string; sendReply: string; resolve: string; reopen: string; resolved: string; anchorRemoved: string; copyLink: string; commentBy: (name: string) => string }
  /** The star in the path. */
  favorite: { on: boolean; label: string; toggle: () => void; disabled: boolean }
  /** The ⋯ menu (its dialogs come in `dialogs`). */
  menu: { items: TaskMenuItem[]; disabled: boolean; onOpen: () => void }
  titleField: {
    value: string; label: string; readOnly: boolean; maxLength: number
    onChange: (value: string) => void
    onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void
    onBlur: () => void
    /** Saves on ⌘/Ctrl+Enter; the layer handles plain Enter (leaves the field) after this. */
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  }
  /** A failed save: its words and a retry. */
  saveError: { text: string; retry: string; onRetry: () => void; busy: boolean } | null
  syncNotice: string | null
  /** Mikka's collaborative description editor; `afterDescription` goes under it (the layer's Copy link row, 验收, sub-tasks), `activity` draws 活动. */
  description: (parts: { afterDescription: ReactNode; activity: (discussions: IssueDiscussions) => ReactNode }) => ReactNode
  /** 验收 (FactoryAcceptance), in the body under the description. */
  acceptance: ReactNode
  copyLink: () => void
  subtasks: { items: TaskSubtask[]; done: number; total: number; onCreate: (title: string) => Promise<boolean>; disabled: boolean; failed: { text: string; retry: () => void } | null } | null
  /** 活动: the task's events and Agent rows; the comments come with `discussions`. */
  activity: {
    items: (discussions: IssueDiscussions) => TaskActivityItem[]
    failed: { text: string; retry: () => void }[]
    /** The comment being written and the reply open on one discussion; sending goes to the discussions last drawn. */
    drafts: { body: string; setBody: (value: string) => void; replyTo: string | null; setReplyTo: (id: string | null) => void; reply: string; setReply: (value: string) => void; submit: () => void; sendReply: (id: string) => void }
    subscribed: boolean
    onSubscribe: () => void
    subscribeLabel: string
  } | null
  /** The details card. */
  rows: TaskDetailRow[]
  /** A failed property save. */
  rowsError: string
  /** Under the rows: the ID and when it was made. */
  meta: string
  /** An open thread or 验收 panel; on a wide screen it takes the details card's place. */
  panel: ReactNode | null
  /** At least 1024px: details beside the body; narrower, details sit above it and a panel covers the page. */
  wide: boolean
  /** The open thread's resize handle and its width. */
  resize: { handle: ReactNode; width: number; dragging: boolean }
  /** Members, description history, the ⋯ menu's and the properties' dialogs. */
  dialogs: ReactNode
}

/**
 * The task view in a chat's work area (decision 2026-11-10): a narrow tab, whose own × closes it, so the layer leaves
 * out the way back, the pager and ✕, places the title before compact properties and the body, and offers expand:
 * the task's full page (2026-11-10 Capy layout decision).
 * Absent (null) on the task page itself.
 */
export type TaskDetailPlacement = { onExpand: () => void; expandLabel: string }
export const TaskDetailPlacementContext = createContext<TaskDetailPlacement | null>(null)
