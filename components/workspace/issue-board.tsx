'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { changeIssuePriority, moveIssue, saveIssue, type listIssues } from '@/app/actions/issues'
import { setIssueDeleted } from '@/app/actions/issue-operations'
import { useActionError } from '@/lib/use-action-error'
import { type KanbanCommitMeta } from '@/components/reui/kanban'
import { KanbanBoard, type CardContext } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { BOARD_COLUMNS, boardColumnOf } from '@/components/blocks/kanban-board-1/components/data'
import type { IssueStatus } from './issue-properties'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Columns = Record<string, Issue[]>

function groupIssues(issues: Issue[]): Columns {
  return Object.fromEntries(BOARD_COLUMNS.map(column => [column.value, issues.filter(issue => boardColumnOf(issue.status) === column.value)]))
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export function IssueBoard({ issues, columns: visibleColumns, hidden, context, onOpen, onDiscuss, onHideColumn, onShowColumn, onUpdated, onBusyChange }: {
  issues: Issue[]
  columns: IssueStatus[]
  hidden: { status: IssueStatus; count: number }[]
  context: CardContext
  onOpen: (id: string) => void
  onDiscuss: (issue: Issue) => void
  onHideColumn: (status: IssueStatus) => void
  onShowColumn: (status: IssueStatus) => void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const translateError = useActionError()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [columns, setColumns] = useState<Columns>(() => groupIssues(issues))
  const [pending, setPending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const issuesKey = JSON.stringify(issues)
  const [sourceKey, setSourceKey] = useState(issuesKey)
  if (issuesKey !== sourceKey && !dragging && !pending) {
    setSourceKey(issuesKey)
    setColumns(groupIssues(issues))
  }
  const [message, setMessage] = useState('')
  const saving = useRef(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const viewportId = useId()
  const instructionsId = useId()
  const [, setCanScroll] = useState({ left: false, right: false })
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    function update() {
      if (!viewport) return
      const left = viewport.scrollLeft > 1
      const right = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1
      setCanScroll(current => current.left === left && current.right === right ? current : { left, right })
    }
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
    viewport.addEventListener('scroll', update, { passive: true })
    update()
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', update) }
  }, [])

  function scrollBoard(direction: -1 | 1) {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.min(viewport.clientWidth * 0.8, 340), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  async function persist(issue: Issue, patch: { status?: string; priority?: string }, rollback: Columns) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    onBusyChange(true)
    setMessage(t('savingProperties'))
    try {
      const result = patch.status ? await moveIssue({ id: issue.id, status: patch.status, revision: issue.revision }) : await changeIssuePriority({ id: issue.id, priority: patch.priority!, revision: issue.revision })
      if (!('issue' in result) || !result.issue) {
        setColumns(rollback)
        const errorMessage = translateError(result.error)
        setMessage(errorMessage)
        toast.error(errorMessage)
        return
      }
      const savedIssue = result.issue
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, status: savedIssue.status, priority: savedIssue.priority, revision: savedIssue.revision, updatedAt: savedIssue.updatedAt } : item)])))
      setMessage(patch.status ? t('moved', { status: statusLabel(patch.status) }) : t('prioritySaved'))
    } catch {
      setColumns(rollback)
      const errorMessage = t('moveRollback')
      setMessage(errorMessage)
      toast.error(errorMessage)
    } finally {
      saving.current = false
      setPending(false)
      onBusyChange(false)
      void onUpdated().catch(() => {})
    }
  }

  function changeStatus(issue: Issue, status: IssueStatus) {
    if (saving.current || dragging || issue.status === status) return
    const target = boardColumnOf(status)
    const next = Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, key === target ? [{ ...issue, status }, ...items.filter(item => item.id !== issue.id)] : items.filter(item => item.id !== issue.id)]))
    setColumns(next)
    void persist(issue, { status }, columns)
  }

  function changePriority(issue: Issue, priority: string) {
    if (saving.current || dragging || issue.priority === priority) return
    setColumns(Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, priority } : item)])))
    void persist(issue, { priority }, columns)
  }

  async function create(status: IssueStatus, title: string) {
    if (saving.current) return false
    saving.current = true
    setPending(true)
    try {
      const result = await saveIssue({ title, content: EMPTY_DOC, status, priority: 'normal' })
      if (!('issue' in result) || !result.issue) { toast.error(translateError(result.error)); return false }
      setMessage(t('created', { title }))
      await onUpdated().catch(() => {})
      return true
    } catch {
      toast.error(t('createFailed'))
      return false
    } finally {
      saving.current = false
      setPending(false)
    }
  }

  async function remove(issue: Issue) {
    if (saving.current) return
    const previous = columns
    setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.filter(item => item.id !== issue.id)])))
    const result = await setIssueDeleted({ id: issue.id, revision: issue.revision }).catch(() => null)
    if (!result || !('issue' in result)) {
      setColumns(previous)
      toast.error(result ? translateError(result.error) : t('deleteFailed'))
      return
    }
    toast(t('deleted', { title: issue.title }), { action: { label: t('undo'), onClick: () => { void setIssueDeleted({ id: issue.id, restore: true }).then(() => onUpdated()) } } })
    void onUpdated().catch(() => {})
  }

  function commit(next: Columns, meta: KanbanCommitMeta<Issue>) {
    if (meta.kind !== 'item' || meta.activeContainer === meta.overContainer) {
      setColumns(meta.previousValue)
      return
    }
    const issue = meta.previousValue[meta.activeContainer]?.find(item => item.id === String(meta.event.active.id))
    if (!issue) { setColumns(meta.previousValue); return }
    setColumns(next)
    void persist(issue, { status: meta.overContainer }, meta.previousValue)
  }

  return <section aria-label={t('label')} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <p role="status" aria-live="polite" className="sr-only">{message}</p>
    <p id={instructionsId} className="sr-only">{t('keyboardHint')}</p>
    <KanbanBoard value={columns} columns={visibleColumns} hiddenColumns={hidden} context={context} onCreate={create} onDelete={issue => { void remove(issue) }} onDiscuss={onDiscuss} onHideColumn={onHideColumn} onShowColumn={onShowColumn} onValueChange={setColumns} onValueCommit={commit} restoreOnCancel pending={pending} onOpen={onOpen} onStatusChange={changeStatus} onPriorityChange={changePriority} onMetadataBusy={busy => { saving.current = busy; setPending(busy); onBusyChange(busy) }} onMetadataSaved={savedIssue => {
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === savedIssue.id ? { ...item, metadata: savedIssue.metadata, revision: savedIssue.revision, updatedAt: savedIssue.updatedAt } : item)])))
      setMessage(t('propertiesSaved'))
      void onUpdated().catch(() => {})
    }} viewportRef={viewportRef} viewportId={viewportId} instructionsId={instructionsId} onViewportKeyDown={event => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        scrollBoard(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        event.currentTarget.scrollTo({ left: event.key === 'Home' ? 0 : event.currentTarget.scrollWidth })
      }
    }} onDragStart={() => { setDragging(true); onBusyChange(true) }} onDragCancel={() => { setDragging(false); onBusyChange(false) }} onDragEnd={() => { setDragging(false); if (!saving.current) onBusyChange(false) }} accessibility={{ screenReaderInstructions: { draggable: t('dragHint') } }} />
  </section>
}
