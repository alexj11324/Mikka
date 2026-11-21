'use client'

import { taskWorkOwner } from '@/lib/issue-metadata'
import type { ReactNode } from 'react'
import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { BoardScreen } from '@ui-slot/board'
import type { BoardScreenCard, BoardScreenColumn, BoardScreenProps } from '@/components/slots/board-contract'
import { TaskContextMenu, type CardContext } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { runMarkKind, type BoardColumn, type BoardTask } from '@/components/blocks/kanban-board-1/components/data'
import { useRunIndicatorLabel } from '@/components/workspace/task-state-icon'
import { runIndicatorOf } from '@/lib/task-state'
import { blockLabel } from '@/components/workspace/block-label'
import { formatDateOnly } from '@/lib/date-only'
import type { TaskBlock } from '@/lib/task-blocked'
import { useIssueBoardSaves } from './issue-board'
import { ISSUE_PRIORITY_CODES, type IssuePriority } from '@/lib/issue-meta'

const isPriority = (value: string): value is IssuePriority => (ISSUE_PRIORITY_CODES as readonly string[]).includes(value)

/**
 * 看板 through the `board` slot's BoardScreen: BoardPage's filtered tasks in its visible columns, the hidden statuses'
 * tasks in 已隐藏, and the same saves and context menu as the shared board.
 */
export function BoardScreenView({ issues, columns: visible, hidden, grouping = 'status', unread, onUnread, blocks, newestRuns, context, onOpen, onDiscuss, onUpdated, onBusyChange, ...screen }: Omit<BoardScreenProps, 'columns' | 'cards' | 'onMove' | 'wrapCard' | 'onOpen'> & {
  issues: BoardTask[]
  /** 显示 › Grouping: the status columns (with 受阻 and 已隐藏), or the four priorities. */
  grouping?: 'status' | 'priority'
  /** Tasks the person marked unread, and the card menu's toggle. */
  unread?: ReadonlySet<string>
  onUnread?: (task: BoardTask, unread: boolean) => void
  columns: BoardColumn[]
  hidden: BoardColumn[]
  blocks: ReadonlyMap<string, TaskBlock>
  newestRuns: ReadonlyMap<string, string>
  context: CardContext
  onOpen: (id: string) => void
  onDiscuss: (issue: BoardTask) => void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Shell.board')
  const tIssue = useTranslations('Issue')
  const tCard = useTranslations('Shell.board.card')
  const tHosted = useTranslations('HostedBoard')
  const runLabel = useRunIndicatorLabel()
  const format = useFormatter()
  const saves = useIssueBoardSaves({ issues, blocks, newestRuns, onUpdated, onBusyChange })
  if (!BoardScreen) throw new Error('Required product UI export missing: board.BoardScreen')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const show = (property: Parameters<CardContext['properties']['has']>[0]) => context.properties.has(property)

  const byPriority = grouping === 'priority'
  const columns: BoardScreenColumn[] = byPriority
    ? ISSUE_PRIORITY_CODES.map(id => ({ id, label: tIssue(`priority.${id}`), locked: false }))
    : [
      ...visible.map(id => ({ id, label: statusLabel(id), locked: false })),
      ...(hidden.length ? [{ id: 'hidden' as const, label: t('hiddenLane'), locked: true }] : []),
    ]
  // Grouped by priority, every shown task sits in its priority's column, in the order the board sorted them.
  const lanes: [BoardScreenColumn['id'], BoardTask[]][] = byPriority
    ? (() => { const all = [...visible, ...hidden].flatMap(column => saves.columns[column] ?? []); return ISSUE_PRIORITY_CODES.map(priority => [priority, all.filter(task => task.priority === priority)]) })()
    : [...visible, ...hidden].map(column => [hidden.includes(column) ? 'hidden' : column, saves.columns[column] ?? []])
  const byId = new Map<string, BoardTask>()
  const cards: BoardScreenCard[] = []
  for (const [column, tasks] of lanes) {
    for (const task of tasks) {
      byId.set(task.id, task)
      const block = blocks.get(task.id)
      const own = context.taskStates?.get(task.id)
      const indicator = own ? runIndicatorOf(own.state) : null
      // A dependency or the person's flag is why the task sits in 受阻; what its Agent is doing is only a mark on the card.
      const ownBlock = block && (block.reason === 'dependency' || block.reason === 'flagged') ? block : null
      const subtasks = context.subtasks.get(task.id)
      const metadata = task.metadata
      const labels = metadata.labels.map(label => label.name)
      const pullRequest = metadata.pullRequests.at(-1)
      const detail = [
        show('assignee') && taskWorkOwner(metadata)?.name,
        show('labels') && labels.length > 0 && [labels.slice(0, 2).join('、'), labels.length > 2 ? `+${labels.length - 2}` : ''].join(' ').trim(),
        show('project') && metadata.project,
        show('pullRequests') && pullRequest && `PR #${pullRequest.url.match(/\/pull\/(\d+)/)?.[1] ?? ''}`.replace(/ #$/, ''),
        show('subtasks') && subtasks?.total && `${tCard('subtasks')} ${subtasks.done}/${subtasks.total}`,
        show('dueDate') && metadata.dueDate && tHosted('due', { date: formatDateOnly(format, metadata.dueDate, { month: 'short', day: 'numeric' }) }),
        show('createdAt') && tHosted('created', { date: format.dateTime(new Date(task.createdAt), { month: 'short', day: 'numeric' }) }),
      ].filter(Boolean)
      // The card's own text line says it is unread: a word in the block's text slot, not a new mark (paid blocks as shipped).
      const isUnread = unread?.has(task.id) ?? false
      const line = [isUnread && tCard('unread'), ...detail].filter(Boolean).join(' · ')
      cards.push({
        id: task.id,
        column,
        title: task.title,
        fullTitle: task.title,
        identifier: show('identifier') ? task.identifier ?? null : null,
        detail: line,
        unread: isUnread,
        priority: show('priority') ? task.priority : null,
        // A task blocked by a dependency or by hand names why. Otherwise the line is the Agent's mark (working, waiting
        // for the person, error) while 智能体状态 is on; the card's column is its status, so a closed task has no line.
        state: ownBlock ? { kind: 'blocked', label: blockLabel(tCard, ownBlock) }
          : indicator && show('agentState') ? { kind: runMarkKind(indicator), label: runLabel(indicator), indicator } : null,
      })
    }
  }

  const wrapCard = (id: string, card: ReactNode) => {
    const task = byId.get(id)
    if (!task) return card
    return <TaskContextMenu task={task} disabled={saves.pending} block={blocks.has(id)} unread={unread?.has(id) ?? false} onUnread={onUnread} onStatusChange={saves.changeStatus} onPriorityChange={saves.changePriority} onMetadataSaved={saves.metadataSaved} onMetadataBusy={saves.metadataBusy} onDelete={issue => { void saves.remove(issue) }} onDiscuss={onDiscuss} onBlockChange={saves.changeBlock}>{card}</TaskContextMenu>
  }

  return <>
    <p role="status" aria-live="polite" className="sr-only">{saves.message}</p>
    <BoardScreen {...screen} columns={columns} cards={cards} onOpen={onOpen} wrapCard={wrapCard} onMove={(id, column) => {
      if (column === 'hidden') return undefined
      if (isPriority(column)) { const task = byId.get(id); return task && task.priority !== column ? saves.changePriority(task, column) : undefined }
      return saves.moveTo(id, column)
    }} />
  </>
}
