import { Circle, CircleDashed, CircleDot, CircleCheck, CircleX, CircleSlash2, CircleGauge, CircleAlert, SignalHigh, SignalMedium, SignalLow } from 'lucide-react'

export const ISSUE_STATUSES = [
  { value: 'backlog', label: 'Backlog', icon: CircleDashed, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  { value: 'todo', label: 'Todo', icon: Circle, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  { value: 'doing', label: 'In Progress', icon: CircleDot, indicatorClassName: 'text-warning-foreground', surfaceClassName: 'bg-warning/5', borderClassName: 'border-warning/20' },
  { value: 'review', label: 'In Review', icon: CircleGauge, indicatorClassName: 'text-success-foreground', surfaceClassName: 'bg-success/5', borderClassName: 'border-success/20' },
  { value: 'done', label: 'Done', icon: CircleCheck, indicatorClassName: 'text-info-foreground', surfaceClassName: 'bg-info/5', borderClassName: 'border-info/20' },
  { value: 'canceled', label: 'Canceled', icon: CircleX, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  { value: 'duplicate', label: 'Duplicate', icon: CircleSlash2, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
] as const

export const ISSUE_PRIORITIES = [
  { value: 'urgent', label: 'Urgent', icon: CircleAlert, iconProps: { strokeWidth: 2.5 } },
  { value: 'high', label: 'High', icon: SignalHigh, iconProps: { strokeWidth: 3, viewBox: '-0.5 4 20 20' } },
  { value: 'normal', label: 'Normal', icon: SignalMedium, iconProps: { strokeWidth: 3, viewBox: '-3 6 20 20' } },
  { value: 'low', label: 'Low', icon: SignalLow, iconProps: { strokeWidth: 3, viewBox: '-5.5 8 20 20' } },
] as const

export type IssueStatus = typeof ISSUE_STATUSES[number]['value']
export type IssueView = 'all' | 'mine' | 'shared' | 'favorites' | 'following' | IssueStatus
export const WORKSPACE_NAME = 'Mikka'
export const WORKSPACE_SLUG = 'mikka'

export function issueIdentifier(number: number | undefined, pendingLabel = 'Unassigned') {
  return number ? `ORV-${number}` : pendingLabel
}
