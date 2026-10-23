'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { changeIssuePriority, moveIssue, type listIssues } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { type KanbanCommitMeta } from '@/components/reui/kanban'
import { KanbanBoard } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { ISSUE_STATUSES, type IssueStatus } from './issue-properties'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Columns = Record<string, Issue[]>

function groupIssues(issues: Issue[]): Columns {
  return Object.fromEntries(ISSUE_STATUSES.map(status => [status.value, issues.filter(issue => issue.status === status.value)]))
}

export function IssueBoard({ issues, onOpen, onCreate, onUpdated, onBusyChange }: {
  issues: Issue[]
  onOpen: (id: string) => void
  onCreate: (status: IssueStatus) => void
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
  const [canScroll, setCanScroll] = useState({ left: false, right: false })
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

  function changeStatus(issue: Issue, status: IssueStatus) {
    if (saving.current || dragging || issue.status === status) return
    const next = Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, key === status ? [{ ...issue, status }, ...items.filter(item => item.id !== issue.id)] : items.filter(item => item.id !== issue.id)]))
    setColumns(next)
    void persist(issue, { status }, columns)
  }

  function changePriority(issue: Issue, priority: string) {
    if (saving.current || dragging || issue.priority === priority) return
    const next = Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, priority } : item)]))
    setColumns(next)
    void persist(issue, { priority }, columns)
  }

  return <section aria-label={t('label')} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pb-2 sm:px-6">
    <div className="flex shrink-0 items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{message}</p>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('scrollLeft')} aria-controls={viewportId} disabled={!canScroll.left} onClick={() => scrollBoard(-1)}><ChevronLeft data-icon="inline-start" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('scrollRight')} aria-controls={viewportId} disabled={!canScroll.right} onClick={() => scrollBoard(1)}><ChevronRight data-icon="inline-start" /></Button>
      </div>
    </div>
    <p id={instructionsId} className="sr-only">{t('keyboardHint')}</p>
    <KanbanBoard value={columns} onValueChange={setColumns} onValueCommit={commit} restoreOnCancel pending={pending} onOpen={onOpen} onCreate={onCreate} onStatusChange={changeStatus} onPriorityChange={changePriority} onMetadataBusy={busy => { saving.current = busy; setPending(busy); onBusyChange(busy) }} onMetadataSaved={savedIssue => {
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
