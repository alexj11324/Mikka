import type { LucideIcon } from 'lucide-react'
import { Circle, CircleCheck, CircleDashed, CircleDot, CircleGauge, CircleSlash2, CircleX } from 'lucide-react'

import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES, type IssuePriority, type IssueStatus } from '@/lib/issue-meta'

interface IssueStatusVisual {
  icon: LucideIcon
  indicatorClassName: string
  surfaceClassName: string
  borderClassName: string
}

const STATUS_VISUALS: Record<IssueStatus, IssueStatusVisual> = {
  backlog: { icon: CircleDashed, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  todo: { icon: Circle, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  doing: { icon: CircleDot, indicatorClassName: 'text-warning-foreground', surfaceClassName: 'bg-warning/5', borderClassName: 'border-warning/20' },
  review: { icon: CircleGauge, indicatorClassName: 'text-success-foreground', surfaceClassName: 'bg-success/5', borderClassName: 'border-success/20' },
  done: { icon: CircleCheck, indicatorClassName: 'text-info-foreground', surfaceClassName: 'bg-info/5', borderClassName: 'border-info/20' },
  canceled: { icon: CircleX, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
  duplicate: { icon: CircleSlash2, indicatorClassName: 'text-muted-foreground', surfaceClassName: 'bg-muted/25', borderClassName: 'border-border' },
}

export const ISSUE_STATUSES = ISSUE_STATUS_CODES.map(value => ({ value, ...STATUS_VISUALS[value] }))

export const ISSUE_PRIORITIES = ISSUE_PRIORITY_CODES.map(value => ({ value }))

export type { IssuePriority, IssueStatus }
export type IssueView = 'all' | 'mine' | 'shared' | IssueStatus
export const WORKSPACE_NAME = 'Orvilo'

export function issueIdentifier(id: string) {
  return `ORV-${id.slice(0, 6).toUpperCase()}`
}
