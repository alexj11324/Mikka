import { type LucideIcon } from 'lucide-react'

import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES, type IssuePriority, type IssueStatus } from '@/lib/issue-meta'
import { ISSUE_PRIORITY_MARKS, ISSUE_STATUS_MARKS, stateMarkTone } from '@/lib/state-mark'
import { statusIconTints } from '@/lib/status-appearance'
import { PRIORITY_ICONS, STATUS_ICONS } from './state-mark'

type Option = { label: string; icon: LucideIcon }
type StatusOption = Option & { surfaceClassName: string; borderClassName: string }
/** A priority's mark is the registry's bars, one filled (low) to three (high), and 紧急 its amber square. */
type PriorityOption = { label: string; icon: LucideIcon }

const statusOptions = {
  backlog: { label: 'Backlog', icon: STATUS_ICONS.backlog, surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  todo: { label: 'Todo', icon: STATUS_ICONS.todo, surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  doing: { label: 'In Progress', icon: STATUS_ICONS.doing, surfaceClassName: 'bg-warning/5', borderClassName: 'border-warning/20' },
  review: { label: 'In Review', icon: STATUS_ICONS.review, surfaceClassName: 'bg-info/5', borderClassName: 'border-info/20' },
  done: { label: 'Done', icon: STATUS_ICONS.done, surfaceClassName: 'bg-success/5', borderClassName: 'border-success/20' },
  canceled: { label: 'Canceled', icon: STATUS_ICONS.canceled, surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  duplicate: { label: 'Duplicate', icon: STATUS_ICONS.duplicate, surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
} as const satisfies Record<IssueStatus, StatusOption>

const priorityOptions = {
  urgent: { label: 'Urgent', icon: PRIORITY_ICONS.urgent },
  high: { label: 'High', icon: PRIORITY_ICONS.high },
  normal: { label: 'Normal', icon: PRIORITY_ICONS.normal },
  low: { label: 'Low', icon: PRIORITY_ICONS.low },
} as const satisfies Record<IssuePriority, PriorityOption>

// The tone of a status or a priority is its mark's (`stateMarkTone`), never a second table: that is what keeps a
// chip and the badge or dot beside it one colour.
export const ISSUE_STATUSES = ISSUE_STATUS_CODES.map(value => {
  const tone = stateMarkTone(ISSUE_STATUS_MARKS[value])
  return { value, ...statusOptions[value], indicatorClassName: statusIconTints[tone], tone }
})
export const ISSUE_PRIORITIES = ISSUE_PRIORITY_CODES.map(value => ({ value, ...priorityOptions[value], tone: stateMarkTone(ISSUE_PRIORITY_MARKS[value]) }))

export type { IssueStatus }
export type IssueView = 'all' | 'mine' | 'shared' | 'favorites' | 'following' | IssueStatus
export { WORKSPACE_NAME, WORKSPACE_SLUG } from '@/lib/workspace-defaults'

/**
 * Shows the id the server resolved with `taskIdentifier` (lib/task-identifier.ts): `MIK-12` or `ALEX-12`.
 * A task without one (a workspace task with no Linear id) shows `pendingLabel`, by default nothing.
 */
export function issueIdentifier(task: { identifier: string | null } | null | undefined, pendingLabel = '') {
  return task?.identifier ?? pendingLabel
}
