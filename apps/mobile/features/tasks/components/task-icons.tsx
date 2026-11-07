import { View } from 'react-native'
import { CircleAlert, CircleCheck, CircleDashed, Clock, Hand, SignalHigh, SignalLow, SignalMedium } from 'lucide-react-native'
import type { TaskGroup } from '@/lib/types'
import { colors } from '@/lib/theme'

/** 待处理 a raised hand, 进行中 a clock, 待办 a dashed circle, 已完成 a check; grey, never a coloured dot (2026-11-07). */
const GROUP_ICON = { pending: Hand, running: Clock, todo: CircleDashed, done: CircleCheck } as const
export const GROUP_LABEL: Record<TaskGroup, string> = { pending: '待处理', running: '进行中', todo: '待办', done: '已完成' }

export function TaskGroupIcon({ group, size = 18, color = colors.secondary }: { group: TaskGroup; size?: number; color?: string }) {
  const Icon = GROUP_ICON[group]
  return <Icon size={size} color={color} strokeWidth={1.9} accessibilityLabel={GROUP_LABEL[group]} />
}

const PRIORITY: Record<string, { label: string; Icon: typeof SignalHigh }> = {
  urgent: { label: '紧急', Icon: CircleAlert },
  high: { label: '高', Icon: SignalHigh },
  normal: { label: '中', Icon: SignalMedium },
  low: { label: '低', Icon: SignalLow },
}
export const priorityLabel = (priority: string) => PRIORITY[priority]?.label ?? '无'

/** The task's priority as the board draws it (bars, urgent a circled !); none keeps its place empty so rows line up. */
export function PriorityIcon({ priority, size = 16 }: { priority: string; size?: number }) {
  const known = PRIORITY[priority]
  if (!known) return <View style={{ width: size, height: size }} />
  return <known.Icon size={size} color={priority === 'urgent' ? colors.ink : colors.secondary} strokeWidth={2.2} accessibilityLabel={`优先级${known.label}`} />
}
