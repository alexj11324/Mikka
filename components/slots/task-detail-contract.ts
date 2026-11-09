// What the task-detail slot receives (docs/ui-overlay.md): a task's page, as Mikka's working pieces. The layer lays
// them out (bar, title and body, the details column or an open thread beside them); every control inside stays
// Mikka's (components/workspace/task-detail.tsx).
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import type { IssueDetailNavigation } from '@/components/workspace/issue-detail-header'

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
  navigation: IssueDetailNavigation
  onClose: () => void
  /** The ⋯ menu: copy link, members, history, delete and the rest (IssueDetailActions). */
  actions: ReactNode
  /** The editable title. */
  titleField: ReactNode
  /** Notices, the description editor with 验收 and 子任务, and the activity. */
  body: ReactNode
  /** Status, priority, scope, assignee, labels, project, PRs, team and relations. */
  properties: ReactNode
  /** An open thread or 验收 panel; on a wide screen it takes the details column's place. */
  panel: ReactNode | null
  /** At least 1024px: details beside the body; narrower, details sit above it and a panel covers the page. */
  wide: boolean
  /** The details column's resize handle and its width, for a layer that keeps it. */
  resize: { handle: ReactNode; width: number; dragging: boolean }
  /** Members and description history. */
  dialogs: ReactNode
}
