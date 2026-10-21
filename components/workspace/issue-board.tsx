'use client'

import { useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { moveIssue, type listIssues } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { type KanbanCommitMeta } from '@/components/reui/kanban'
import { KanbanBoard } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { Button } from '@/components/ui/button'
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
  const statusT = useTranslations('Issue.status')
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
  const translateError = useActionError()
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

  function scrollBoard(direction: -1 | 1) {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.min(viewport.clientWidth * 0.8, 340), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  async function persist(issue: Issue, status: string, rollback: Columns) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    onBusyChange(true)
    setMessage(t('saving'))
    try {
      const result = await moveIssue({ id: issue.id, status, revision: issue.revision })
      if ('error' in result) {
        setColumns(rollback)
        setMessage(translateError(result.error))
        return
      }
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, status, revision: result.issue.revision, updatedAt: result.issue.updatedAt } : item)])))
      setMessage(t('moved', { status: statusLabel(status) }))
    } catch {
      setColumns(rollback)
      setMessage(t('moveRollback'))
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
    void persist(issue, meta.overContainer, meta.previousValue)
  }

  return <section aria-label={t('label')} className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-6 sm:px-6">
    <div className="flex items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{message || t('instructions')}</p>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('scrollLeft')} aria-controls={viewportId} onClick={() => scrollBoard(-1)}><ChevronLeft data-icon="inline-start" /></Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('scrollRight')} aria-controls={viewportId} onClick={() => scrollBoard(1)}><ChevronRight data-icon="inline-start" /></Button>
      </div>
    </div>
    <p id={instructionsId} className="sr-only">{t('keyboardHint')}</p>
    <KanbanBoard value={columns} onValueChange={setColumns} onValueCommit={commit} restoreOnCancel pending={pending} onOpen={onOpen} onCreate={onCreate} viewportRef={viewportRef} viewportId={viewportId} instructionsId={instructionsId} onViewportKeyDown={event => {
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
