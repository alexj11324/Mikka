import { CircleDashed, Circle, CircleDot, CirclePause, CircleCheck, CircleX, Minus, SignalHigh, SignalMedium, SignalLow, AlertCircle } from 'lucide-react'
export const PROJECT_PRIORITIES = [
  { value: 'none', label: '无优先级', icon: Minus },
  { value: 'urgent', label: '紧急', icon: AlertCircle },
  { value: 'high', label: '高优先级', icon: SignalHigh },
  { value: 'normal', label: '普通优先级', icon: SignalMedium },
  { value: 'low', label: '低优先级', icon: SignalLow },
] as const
export const PROJECT_COLORS = [
  { value: 'green', label: '绿色', className: 'text-success-foreground', surface: 'bg-success/10' },
  { value: 'purple', label: '紫色', className: 'text-info-foreground', surface: 'bg-info/10' },
  { value: 'yellow', label: '黄色', className: 'text-warning-foreground', surface: 'bg-warning/10' },
  { value: 'gray', label: '灰色', className: 'text-muted-foreground', surface: 'bg-muted' },
] as const
export const PROJECT_ICON_COLORS = { green: 'bg-success/10 text-success-foreground', purple: 'bg-info/10 text-info-foreground', yellow: 'bg-warning/10 text-warning-foreground', gray: 'bg-muted text-muted-foreground' } as const
export const PROJECT_ICON_TINTS = { green: 'text-success-foreground', purple: 'text-info-foreground', yellow: 'text-warning-foreground', gray: 'text-muted-foreground' } as const
export const PROJECT_HEALTH = [
  { value: 'none', label: '未评估', icon: CircleDashed },
  { value: 'onTrack', label: '正常推进', icon: CircleCheck },
  { value: 'atRisk', label: '存在风险', icon: CirclePause },
  { value: 'offTrack', label: '已偏离计划', icon: CircleX },
] as const
export type ProjectControlField = 'status' | 'priority' | 'lead' | 'members' | 'startDate' | 'targetDate' | 'labels' | 'dependencyIds' | 'health'

import type { listProjects } from '@/app/actions/projects'
export type Project = Awaited<ReturnType<typeof listProjects>>[number]
export const PROJECT_STATUSES = [
  { value: 'backlog', label: '待规划', icon: CircleDashed },
  { value: 'planned', label: '已计划', icon: Circle },
  { value: 'started', label: '进行中', icon: CircleDot },
  { value: 'paused', label: '已暂停', icon: CirclePause },
  { value: 'completed', label: '已完成', icon: CircleCheck },
  { value: 'canceled', label: '已取消', icon: CircleX },
] as const
