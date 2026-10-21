import { CircleDashed, Circle, CircleDot, CirclePause, CircleCheck, CircleX, Minus, SignalHigh, SignalMedium, SignalLow, AlertCircle } from 'lucide-react'
export const PROJECT_PRIORITIES = [
  { value: 'none', icon: Minus },
  { value: 'urgent', icon: AlertCircle },
  { value: 'high', icon: SignalHigh },
  { value: 'normal', icon: SignalMedium },
  { value: 'low', icon: SignalLow },
] as const
export const PROJECT_COLORS = [
  { value: 'green', className: 'text-success-foreground', surface: 'bg-success/10' },
  { value: 'purple', className: 'text-info-foreground', surface: 'bg-info/10' },
  { value: 'yellow', className: 'text-warning-foreground', surface: 'bg-warning/10' },
  { value: 'gray', className: 'text-muted-foreground', surface: 'bg-muted' },
] as const
export const PROJECT_ICON_COLORS = { green: 'bg-success/10 text-success-foreground', purple: 'bg-info/10 text-info-foreground', yellow: 'bg-warning/10 text-warning-foreground', gray: 'bg-muted text-muted-foreground' } as const
export const PROJECT_ICON_TINTS = { green: 'text-success-foreground', purple: 'text-info-foreground', yellow: 'text-warning-foreground', gray: 'text-muted-foreground' } as const
export const PROJECT_HEALTH = [
  { value: 'none', icon: CircleDashed },
  { value: 'onTrack', icon: CircleCheck },
  { value: 'atRisk', icon: CirclePause },
  { value: 'offTrack', icon: CircleX },
] as const
export type ProjectControlField = 'status' | 'priority' | 'lead' | 'members' | 'startDate' | 'targetDate' | 'labels' | 'dependencyIds' | 'health'

import type { listProjects } from '@/app/actions/projects'
export type Project = Awaited<ReturnType<typeof listProjects>>[number]
export const PROJECT_STATUSES = [
  { value: 'backlog', icon: CircleDashed },
  { value: 'planned', icon: Circle },
  { value: 'started', icon: CircleDot },
  { value: 'paused', icon: CirclePause },
  { value: 'completed', icon: CircleCheck },
  { value: 'canceled', icon: CircleX },
] as const
