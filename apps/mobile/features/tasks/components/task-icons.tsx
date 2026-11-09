import { mobileMessages } from '@/lib/messages'
import { View } from 'react-native'
import { Circle, CircleAlert, CircleCheck, CircleDashed, CircleDot, CircleGauge, CirclePause, CircleSlash2, CircleX, Clock, Hand, OctagonAlert, SignalHigh, SignalLow, SignalMedium, TriangleAlert } from 'lucide-react-native'
import type { TaskGroup, TaskState } from '@/lib/types'
import { ATTEMPT_WORD, type AttemptResult } from '../model/task-groups'
import { colors } from '@/lib/theme'

/**
 * One icon per state (decisions/2026-11-07-2230-one-icon-per-task-state.md). The hand is only 等你处理; 失败 is a
 * triangle (✕ is the board's 已取消); 受阻 an octagon (login, key, permission, quota, a device offline); 运行中 the
 * board's In Progress ring; 排队中 a clock. Each glyph has its state's system colour (decisions/2026-11-08-0130): needs
 * you blue, blocked or under way orange, failed red, done green, not started or closed grey. Never a coloured dot.
 */
const STATE_COLOR: Record<TaskState, string> = { waiting: colors.accent, failed: colors.danger, blocked: colors.orange, running: colors.orange, queued: colors.orange }
const STATE_ICON: Record<TaskState, typeof Hand> = { waiting: Hand, failed: TriangleAlert, blocked: OctagonAlert, running: CircleDot, queued: Clock }
export const STATE_LABEL: Record<TaskState, string> = mobileMessages.MobileCore.states

/** The board's status icons (components/workspace/issue-properties.ts), so a task looks the same on the board and in a list. */
const BOARD_ICON: Record<string, typeof Hand> = { backlog: CircleDashed, todo: Circle, doing: CircleDot, review: CircleGauge, done: CircleCheck, canceled: CircleX, duplicate: CircleSlash2 }
const BOARD_COLOR: Record<string, string> = { backlog: colors.tertiary, todo: colors.tertiary, doing: colors.orange, review: colors.accent, done: colors.success, canceled: colors.secondary, duplicate: colors.secondary }
export const BOARD_LABEL: Record<string, string> = mobileMessages.MobileCore.board

/** A row's icon: its state's, or with none its board status's. */
export function TaskStateIcon({ state, status, size = 18 }: { state: TaskState | null; status: string; size?: number }) {
  const Icon = state ? STATE_ICON[state] : BOARD_ICON[status] ?? Circle
  const color = state ? STATE_COLOR[state] : BOARD_COLOR[status] ?? colors.tertiary
  return <Icon size={size} color={color} strokeWidth={1.9} accessibilityLabel={state ? STATE_LABEL[state] : BOARD_LABEL[status] ?? status} />
}

/** An attempt's own result (never the hand): ring, pause, check, triangle, octagon. */
const ATTEMPT_ICON: Record<AttemptResult, typeof Hand> = { running: CircleDot, paused: CirclePause, done: CircleCheck, failed: TriangleAlert, blocked: OctagonAlert }
const ATTEMPT_COLOR: Record<AttemptResult, string> = { running: colors.orange, paused: colors.accent, done: colors.success, failed: colors.danger, blocked: colors.orange }

export function AttemptIcon({ result, size = 18 }: { result: AttemptResult; size?: number }) {
  const Icon = ATTEMPT_ICON[result]
  return <Icon size={size} color={ATTEMPT_COLOR[result]} strokeWidth={1.9} accessibilityLabel={ATTEMPT_WORD[result]} />
}

/** A group header's icon: 等待你 the hand, 进行中 the ring, 待办 ◌, 已完成 ✓. Rows never borrow it. */
const GROUP_ICON = { pending: Hand, running: CircleDot, todo: CircleDashed, done: CircleCheck } as const
const GROUP_COLOR: Record<TaskGroup, string> = { pending: colors.accent, running: colors.orange, todo: colors.tertiary, done: colors.success }
export const GROUP_LABEL: Record<TaskGroup, string> = mobileMessages.MobileCore.groups

export function TaskGroupIcon({ group, size = 18, color = GROUP_COLOR[group] }: { group: TaskGroup; size?: number; color?: string }) {
  const Icon = GROUP_ICON[group]
  return <Icon size={size} color={color} strokeWidth={1.9} accessibilityLabel={GROUP_LABEL[group]} />
}

const PRIORITY: Record<string, { label: string; Icon: typeof SignalHigh }> = {
  urgent: { label: mobileMessages.Issue.priority.urgent, Icon: CircleAlert },
  high: { label: mobileMessages.Issue.priority.high, Icon: SignalHigh },
  normal: { label: mobileMessages.Issue.priority.normal, Icon: SignalMedium },
  low: { label: mobileMessages.Issue.priority.low, Icon: SignalLow },
}
export const priorityLabel = (priority: string) => PRIORITY[priority]?.label ?? mobileMessages.MobileCore.noPriority

/** The task's priority as the board draws it (bars, urgent a circled !); none keeps its place empty so rows line up. */
export function PriorityIcon({ priority, size = 16 }: { priority: string; size?: number }) {
  const known = PRIORITY[priority]
  if (!known) return <View style={{ width: size, height: size }} />
  return <known.Icon size={size} color={priority === 'urgent' ? colors.ink : colors.secondary} strokeWidth={2.2} accessibilityLabel={mobileMessages.MobileCore.priority.replace('{priority}', known.label)} />
}
