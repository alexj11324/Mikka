// The one renderer for the mark registry (`lib/state-mark.ts`): `{shape, tone, size}` in, the mark drawn out.
// Geometry is fixed — a 14 box, the shape stroked in `currentColor` at 1.25, circles r=5 around (7, 7) — and the
// renderer takes no `className`: a mark's colour is its tone and its size is its `size`, so a call site cannot
// paint one of its own and every class in this file stays statically readable (`style/static-layout-only`).
import { forwardRef, type ComponentPropsWithRef, type ReactNode } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ISSUE_PRIORITY_MARKS, ISSUE_STATUS_MARKS, markToneClass, statusMarkOf, type MarkShape, type MarkSize, type MarkSpec, type MarkTone } from '@/lib/state-mark'
import type { IssuePriority, IssueStatus } from '@/lib/issue-meta'

/** The glyph inside a filled disc (check, x) is cut in the surface's colour, as `--status-icon-surface` has it. */
const CUT = { stroke: 'var(--status-icon-surface, var(--background))', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** The three priority bars: bottom-aligned at 12.5, filled ones at full ink and the others at a quarter of it. */
const bars = (filled: number, heights: readonly number[]) => heights.map((height, index) =>
  <rect key={height} x={[1, 5.5, 10][index]} y={12.5 - height} width="3" height={height} rx="1" fill="currentColor" opacity={index < filled ? 1 : 0.25} />)

const MARK_SHAPES: Record<MarkShape, ReactNode> = {
  /** 待整理: a dashed ring. */
  dashed: <circle cx="7" cy="7" r="5" strokeDasharray="2 2" />,
  /** 待办, a thread's 空闲: an open ring. */
  empty: <circle cx="7" cy="7" r="5" />,
  /** 进行中: a ring, its right half filled. */
  half: <><circle cx="7" cy="7" r="5" /><path d="M7 2a5 5 0 0 1 0 10z" fill="currentColor" stroke="none" /></>,
  /** 评审中, a run under way: a ring with the work done as an arc around it. */
  progress: <><circle cx="7" cy="7" r="5" opacity={0.3} /><path d="M7 2A5 5 0 1 1 2 7" /></>,
  /** 已完成: a filled disc with the check cut out. */
  check: <><circle cx="7" cy="7" r="5" fill="currentColor" /><path d="M4.4 7.15 6.15 8.9 9.6 5.4" {...CUT} /></>,
  /** 已取消, a blocked run: a filled disc with the cross cut out. */
  x: <><circle cx="7" cy="7" r="5" fill="currentColor" /><path d="M5.2 5.2 8.8 8.8M8.8 5.2 5.2 8.8" {...CUT} /></>,
  /** 重复: a ring struck through. */
  slash: <><circle cx="7" cy="7" r="5" /><path d="M3.5 10.5 10.5 3.5" /></>,
  /** 等待你: a raised hand. */
  hand: <>
    <path d="M4.6 7.3v3.2a2.8 2.8 0 0 0 2.8 2.8h.7a2.8 2.8 0 0 0 2.8-2.8V7.3" />
    <path d="M5.95 7.2V3.5M7.4 7.2V2.9M8.85 7.2V3.9" />
    <path d="M4.7 8.9 3.2 7.5" />
  </>,
  /** A question the person has to answer, where a state is a question. */
  question: <>
    <circle cx="7" cy="7" r="5" />
    <path d="M5.85 5.5a1.15 1.15 0 1 1 1.75 1.05c-.35.2-.6.55-.6 1" />
    <circle cx="7" cy="9.9" r=".7" fill="currentColor" stroke="none" />
  </>,
  /** A failed run: a triangle with a point under it. */
  alert: <>
    <path d="M6.32 2.72a.8.8 0 0 1 1.36 0l4.3 7.6a.8.8 0 0 1-.68 1.18H2.7a.8.8 0 0 1-.68-1.18z" />
    <path d="M7 5.6v2.3" />
    <circle cx="7" cy="9.9" r=".65" fill="currentColor" stroke="none" />
  </>,
  /** 紧急: the one solid mark — an amber square with its point cut in `--warning-ink`, a fill rather than a line. */
  urgent: <>
    <rect width="14" height="14" rx="3" fill="var(--warning)" stroke="none" />
    <path d="M7 3.5v4.25" stroke="var(--warning-ink)" strokeWidth={1.75} />
    <circle cx="7" cy="10.25" r="1" fill="var(--warning-ink)" stroke="none" />
  </>,
  /** 低: one bar of three filled. */
  'bars-1': bars(1, [4, 7.5, 11]),
  /** 中: two bars of three filled. */
  'bars-2': bars(2, [4, 7.5, 11]),
  /** 高: three bars filled. */
  'bars-3': bars(3, [4, 7.5, 11]),
}

export type MarkProps = Omit<ComponentPropsWithRef<'svg'>, 'viewBox' | 'children' | 'className'> & {
  shape: MarkShape
  /** Absent draws the shape in the colour of where it sits. */
  tone?: MarkTone
  size?: MarkSize
  /** A run that is still going: the one motion a mark has. */
  spin?: boolean
}

/** The one renderer. `data-mark` names the shape it drew, for a test or a bug report. */
export function Mark({ shape, tone, size = 'sm', spin = false, 'aria-hidden': ariaHidden = true, ...rest }: MarkProps) {
  return (
    <svg {...rest} aria-hidden={ariaHidden} data-mark={shape} viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', tone && markToneClass[tone], size === 'lg' ? 'size-[18px]' : size === 'md' ? 'size-4' : 'size-3.5', spin && 'motion-safe:animate-spin [animation-duration:1.6s]')}>
      {MARK_SHAPES[shape]}
    </svg>
  )
}

/** A mark as its own component, for the places that take an icon (`ISSUE_STATUSES`, a menu row). */
function markIcon(name: string, spec: MarkSpec, spin?: boolean): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ size: _size, absoluteStrokeWidth: _absolute, ...props }, ref) =>
    <Mark ref={ref} {...spec} spin={spin} {...props} />)
  Icon.displayName = name
  return Icon
}

/** The seven status glyphs, one per `IssueStatus`, so every surface draws a status from the same row. */
export const STATUS_ICONS: Record<IssueStatus, LucideIcon> = {
  backlog: markIcon('StatusBacklogIcon', ISSUE_STATUS_MARKS.backlog),
  todo: markIcon('StatusTodoIcon', ISSUE_STATUS_MARKS.todo),
  doing: markIcon('StatusProgressIcon', ISSUE_STATUS_MARKS.doing),
  review: markIcon('StatusReviewIcon', ISSUE_STATUS_MARKS.review),
  done: markIcon('StatusDoneIcon', ISSUE_STATUS_MARKS.done),
  canceled: markIcon('StatusCanceledIcon', ISSUE_STATUS_MARKS.canceled),
  duplicate: markIcon('StatusDuplicateIcon', ISSUE_STATUS_MARKS.duplicate),
}

/** The four priority glyphs, from the same registry, so a priority has one drawing and one colour. */
export const PRIORITY_ICONS: Record<IssuePriority, LucideIcon> = {
  urgent: markIcon('PriorityUrgentIcon', ISSUE_PRIORITY_MARKS.urgent),
  high: markIcon('PriorityHighIcon', ISSUE_PRIORITY_MARKS.high),
  normal: markIcon('PriorityNormalIcon', ISSUE_PRIORITY_MARKS.normal),
  low: markIcon('PriorityLowIcon', ISSUE_PRIORITY_MARKS.low),
}

/** A status as its mark, for a surface that only has the status key. */
export function StateMark({ state, size, ...rest }: { state: string; size?: MarkSize } & Omit<MarkProps, 'shape' | 'tone' | 'size'>) {
  const { shape, tone } = statusMarkOf(state)
  return <Mark {...rest} shape={shape} tone={tone} size={size} data-task-status={state} />
}
