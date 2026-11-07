import { View } from 'react-native'
import { Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleGauge, CircleSlash2, CircleX, Clock, Hand, SignalHigh, SignalLow, SignalMedium, TriangleAlert } from 'lucide-react-native'
import type { TaskGroup, TaskState } from '@/lib/types'
import { colors } from '@/lib/theme'

/**
 * One icon per state (decisions/2026-11-07-2230-one-icon-per-task-state.md). The hand is only 等你处理; 失败 is a
 * triangle (✕ is the board's 已取消); 运行中 the board's In Progress ring; 排队中 a clock. Grey, never a coloured dot.
 */
const STATE_ICON: Record<TaskState, typeof Hand> = { waiting: Hand, failed: TriangleAlert, running: CircleDot, queued: Clock }
export const STATE_LABEL: Record<TaskState, string> = { waiting: '等你处理', failed: '失败', running: '运行中', queued: '排队中' }

/** The board's status icons (components/workspace/issue-properties.ts), so a task looks the same on the board and in a list. */
const BOARD_ICON: Record<string, typeof Hand> = { backlog: CircleDashed, todo: Circle, doing: CircleDot, review: CircleGauge, done: CircleCheck, canceled: CircleX, duplicate: CircleSlash2 }
export const BOARD_LABEL: Record<string, string> = { backlog: '暂不处理', todo: '待办', doing: '进行中', review: '评审中', done: '完成', canceled: '已取消', duplicate: '重复' }

/** A row's icon: its state's, or with none its board status's. */
export function TaskStateIcon({ state, status, size = 18 }: { state: TaskState | null; status: string; size?: number }) {
  const Icon = state ? STATE_ICON[state] : BOARD_ICON[status] ?? Circle
  return <Icon size={size} color={colors.secondary} strokeWidth={1.9} accessibilityLabel={state ? STATE_LABEL[state] : BOARD_LABEL[status] ?? status} />
}

/** A group header's icon: 等待你 the hand, 进行中 the ring, 待办 ◌, 已完成 ✓. Rows never borrow it. */
const GROUP_ICON = { pending: Hand, running: CircleDot, todo: CircleDashed, done: CircleCheck } as const
export const GROUP_LABEL: Record<TaskGroup, string> = { pending: '等待你', running: '进行中', todo: '待办', done: '已完成' }

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
