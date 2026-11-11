'use client'

import type { ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { BoardScreen } from '@ui-slot/board'
import type { BoardScreenCard, BoardScreenColumn, BoardScreenProps } from '@/components/slots/board-contract'
import { TaskContextMenu, type CardContext } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { cardStateKind, type BoardColumn, type BoardTask } from '@/components/blocks/kanban-board-1/components/data'
import { localTaskState } from '@/hooks/use-bot-tasks'
import { useTaskStateLabel } from '@/components/workspace/task-state-icon'
import { blockLabel } from '@/components/workspace/block-label'
import { displayTaskTitle } from '@/lib/short-title'
import { formatDateOnly } from '@/lib/date-only'
import type { TaskBlock } from '@/lib/task-blocked'
import { useIssueBoardSaves } from './issue-board'

const DONE = ['done', 'canceled', 'duplicate']

/**
 * 看板 through the `board` slot's BoardScreen: BoardPage's filtered tasks in its visible columns, the hidden statuses'
 * tasks in 已隐藏, and the same saves and context menu as the shared board.
 */
export function BoardScreenView({ issues, columns: visible, hidden, blocks, newestRuns, context, onOpen, onDiscuss, onUpdated, onBusyChange, ...screen }: Omit<BoardScreenProps, 'columns' | 'cards' | 'onMove' | 'wrapCard' | 'onOpen'> & {
  issues: BoardTask[]
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
  const stateLabel = useTaskStateLabel()
  const format = useFormatter()
  const saves = useIssueBoardSaves({ issues, blocks, newestRuns, onUpdated, onBusyChange })
  if (!BoardScreen) throw new Error('Required product UI export missing: board.BoardScreen')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const show = (property: Parameters<CardContext['properties']['has']>[0]) => context.properties.has(property)

  const columns: BoardScreenColumn[] = [
    ...visible.map(id => ({ id, label: statusLabel(id), locked: false })),
    ...(hidden.length ? [{ id: 'hidden' as const, label: t('hiddenLane'), locked: true }] : []),
  ]
  const byId = new Map<string, BoardTask>()
  const cards: BoardScreenCard[] = []
  for (const column of [...visible, ...hidden]) {
    for (const task of saves.columns[column] ?? []) {
      byId.set(task.id, task)
      const block = blocks.get(task.id)
      // The task's own state (localTaskState on its newest run, decision #1864 point 6), never the run's group.
      const own = context.taskStates?.get(task.id) ?? localTaskState(task, undefined)
      const kind = cardStateKind(own.state)
      // A dependency or the person's flag is the task's own 受阻 and names why; what a thread says is the task's state.
      const ownBlock = block && (block.reason === 'dependency' || block.reason === 'flagged') ? block : null
      const subtasks = context.subtasks.get(task.id)
      const metadata = task.metadata
      const labels = metadata.labels.map(label => label.name)
      const pullRequest = metadata.pullRequests.at(-1)
      const detail = [
        show('assignee') && metadata.assignee?.name,
        show('labels') && labels.length > 0 && [labels.slice(0, 2).join('、'), labels.length > 2 ? `+${labels.length - 2}` : ''].join(' ').trim(),
        show('project') && metadata.project,
        show('pullRequests') && pullRequest && `PR #${pullRequest.url.match(/\/pull\/(\d+)/)?.[1] ?? ''}`.replace(/ #$/, ''),
        show('subtasks') && subtasks?.total && `${tCard('subtasks')} ${subtasks.done}/${subtasks.total}`,
        show('dueDate') && metadata.dueDate && tHosted('due', { date: formatDateOnly(format, metadata.dueDate, { month: 'short', day: 'numeric' }) }),
        show('createdAt') && tHosted('created', { date: format.dateTime(new Date(task.createdAt), { month: 'short', day: 'numeric' }) }),
      ].filter(Boolean).join(' · ')
      cards.push({
        id: task.id,
        column: hidden.includes(column) ? 'hidden' : column,
        title: displayTaskTitle(task),
        fullTitle: task.title,
        identifier: show('identifier') ? task.identifier ?? null : null,
        detail,
        priority: show('priority') ? task.priority : null,
        // A task blocked by a dependency or by hand names why; otherwise the task's own state, shown while 智能体状态 is on,
        // when a thread stops it (受阻), or once it is closed.
        state: ownBlock ? { kind: 'blocked', label: blockLabel(tCard, ownBlock) }
          : kind && (show('agentState') || block || DONE.includes(task.status)) ? { kind, label: stateLabel(own.state, own.reason) } : null,
      })
    }
  }

  const wrapCard = (id: string, card: ReactNode) => {
    const task = byId.get(id)
    if (!task) return card
    return <TaskContextMenu task={task} disabled={saves.pending} block={blocks.has(id)} onStatusChange={saves.changeStatus} onPriorityChange={saves.changePriority} onMetadataSaved={saves.metadataSaved} onMetadataBusy={saves.metadataBusy} onDelete={issue => { void saves.remove(issue) }} onDiscuss={onDiscuss} onBlockChange={saves.changeBlock}>{card}</TaskContextMenu>
  }

  return <>
    <p role="status" aria-live="polite" className="sr-only">{saves.message}</p>
    <BoardScreen {...screen} columns={columns} cards={cards} onOpen={onOpen} wrapCard={wrapCard} onMove={(id, column) => { if (column !== 'hidden') saves.moveTo(id, column) }} />
  </>
}
