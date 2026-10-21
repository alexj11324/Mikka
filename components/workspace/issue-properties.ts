import { Circle, CircleDashed, CircleDot, CircleCheck, CircleX, CircleSlash2, CircleGauge } from 'lucide-react'

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
  { value: 'urgent', label: '紧急' },
  { value: 'high', label: '高优先级' },
  { value: 'normal', label: '普通优先级' },
  { value: 'low', label: '低优先级' },
] as const

export type IssueStatus = typeof ISSUE_STATUSES[number]['value']
export type IssueView = 'all' | 'mine' | 'shared' | IssueStatus
export const WORKSPACE_NAME = 'Orvilo3'
export const WORKSPACE_SLUG = 'orvilo3'

export function issueIdentifier(id: string) {
  return `ORV-${id.slice(0, 6).toUpperCase()}`
}
