import { Circle, CircleDashed, CircleDot, CircleCheck, CircleX, CircleSlash2, CircleGauge, CircleAlert, SignalHigh, SignalMedium, SignalLow, type LucideIcon } from 'lucide-react'

import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES, type IssuePriority, type IssueStatus } from '@/lib/issue-meta'
import { statusTone } from '@/lib/status-appearance'

type Option = { label: string; icon: LucideIcon }
type StatusOption = Option & { indicatorClassName: string; surfaceClassName: string; borderClassName: string }
type PriorityOption = Option & { iconProps: { strokeWidth: number; viewBox?: string } }

const statusOptions = {
  backlog: { label: 'Backlog', icon: CircleDashed, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  todo: { label: 'Todo', icon: Circle, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  doing: { label: 'In Progress', icon: CircleDot, indicatorClassName: 'text-warning-foreground', surfaceClassName: 'bg-warning/5', borderClassName: 'border-warning/20' },
  review: { label: 'In Review', icon: CircleGauge, indicatorClassName: 'text-info-foreground', surfaceClassName: 'bg-info/5', borderClassName: 'border-info/20' },
  done: { label: 'Done', icon: CircleCheck, indicatorClassName: 'text-success-foreground', surfaceClassName: 'bg-success/5', borderClassName: 'border-success/20' },
  canceled: { label: 'Canceled', icon: CircleX, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  duplicate: { label: 'Duplicate', icon: CircleSlash2, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
} as const satisfies Record<IssueStatus, StatusOption>

const priorityOptions = {
  urgent: { label: 'Urgent', icon: CircleAlert, iconProps: { strokeWidth: 2.5 } },
  high: { label: 'High', icon: SignalHigh, iconProps: { strokeWidth: 3, viewBox: '-0.5 4 20 20' } },
  normal: { label: 'Normal', icon: SignalMedium, iconProps: { strokeWidth: 3, viewBox: '-3 6 20 20' } },
  low: { label: 'Low', icon: SignalLow, iconProps: { strokeWidth: 3, viewBox: '-5.5 8 20 20' } },
} as const satisfies Record<IssuePriority, PriorityOption>

export const ISSUE_STATUSES = ISSUE_STATUS_CODES.map(value => ({ value, ...statusOptions[value], tone: statusTone(value) }))
export const ISSUE_PRIORITIES = ISSUE_PRIORITY_CODES.map(value => ({ value, ...priorityOptions[value], tone: statusTone(value) }))

export type { IssueStatus }
export type IssueView = 'all' | 'mine' | 'shared' | 'favorites' | 'following' | IssueStatus
export const WORKSPACE_NAME = 'Mikka'
export const WORKSPACE_SLUG = 'mikka'

/**
 * Shows the id the server resolved with `taskIdentifier` (lib/task-identifier.ts): `MIK-12` or `ALEX-12`.
 * A task without one (a workspace task with no Linear id) shows `pendingLabel`, by default nothing.
 */
export function issueIdentifier(task: { identifier: string | null } | null | undefined, pendingLabel = '') {
  return task?.identifier ?? pendingLabel
}
