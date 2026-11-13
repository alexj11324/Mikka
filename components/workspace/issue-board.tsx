'use client'

import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { changeIssuePriority, getIssue, moveIssue, type listIssues } from '@/app/actions/issues'
import { setIssueDeleted } from '@/app/actions/issue-operations'
import { updateIssueMetadata } from '@/app/actions/issue-metadata'
import { clearedBlock, FLAGGED_BLOCK, type BlockFlag, type TaskBlock } from '@/lib/task-blocked'
import { useActionError } from '@/lib/use-action-error'
import type { MetadataSavedIssue } from './issue-metadata-controls'
import { type KanbanCommitMeta } from '@/components/reui/kanban'
import { KanbanBoard, type CardContext } from '@/components/blocks/kanban-board-1/components/kanban-board'
import { BLOCKED_COLUMN, BOARD_COLUMNS, boardColumnOf, type BoardColumn } from '@/components/blocks/kanban-board-1/components/data'
import type { IssueStatus } from './issue-properties'
import { boardScrollTo, boardStartColumn } from '@/lib/board-start-column'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Columns = Record<string, Issue[]>

function groupIssues(issues: Issue[], blocks: ReadonlyMap<string, TaskBlock>): Columns {
  return Object.fromEntries(BOARD_COLUMNS.map(column => [column.value, issues.filter(issue => boardColumnOf(issue.status, blocks.has(issue.id)) === column.value)]))
}

/** The card fade's length, matching `duration-150` on the card. */
const CARD_MOTION_MS = 150

/**
 * The board's columns and every save behind them: status, 受阻, priority, delete, a drop and the metadata editors.
 * The shared board and a UI layer's own board (the `board` slot's BoardScreen) use the same saves.
 */
export function useIssueBoardSaves({ issues, blocks, newestRuns, onUpdated, onBusyChange }: {
  issues: Issue[]
  blocks: ReadonlyMap<string, TaskBlock>
  newestRuns: ReadonlyMap<string, string>
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const tDetail = useTranslations('IssueDetail')
  const tTransport = useTranslations('RunErrors')
  const translateError = useActionError()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [columns, setColumns] = useState<Columns>(() => groupIssues(issues, blocks))
  const [pending, setPending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const issuesKey = JSON.stringify([issues, [...blocks.keys()]])
  const [sourceKey, setSourceKey] = useState(issuesKey)
  if (issuesKey !== sourceKey && !dragging && !pending) {
    setSourceKey(issuesKey)
    setColumns(groupIssues(issues, blocks))
  }
  const [message, setMessage] = useState('')
  // Only the person's own moves animate (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md): a card moved with the status menu fades in at its
  // new place, a deleted card fades out before it leaves. Changes from others, and drags (dnd-kit animates those), snap.
  const [cardMotion, setCardMotion] = useState<ReadonlyMap<string, 'enter' | 'leave'>>(() => new Map())
  const setMotion = (id: string, kind: 'enter' | 'leave' | null) => setCardMotion(current => {
    const next = new Map(current)
    if (kind) next.set(id, kind)
    else next.delete(id)
    return next
  })
  const saving = useRef(false)
  async function persist(issue: Issue, patch: { status?: string; priority?: string; block?: BlockFlag }, rollback: Columns) {
    if (saving.current) return false
    saving.current = true
    const errorToastId = `board-change:${issue.id}`
    toast.dismiss(errorToastId)
    setPending(true)
    onBusyChange(true)
    setMessage(t('savingProperties'))
    try {
      const write = patch.status
        ? moveIssue({ id: issue.id, status: patch.status, revision: issue.revision, block: patch.block })
        : patch.priority
          ? changeIssuePriority({ id: issue.id, priority: patch.priority, revision: issue.revision })
          : updateIssueMetadata({ id: issue.id, revision: issue.revision, patch: { block: patch.block } })
      // A lost response can follow a committed write. Read once under the current
      // task permissions and never resend the mutation to discover its outcome.
      let verifiedByRead = false
      const result = await write.catch(async (error: unknown) => {
        const failure = error && typeof error === 'object' ? error : null
        const status = failure && 'status' in failure ? failure.status : undefined
        if (failure && 'code' in failure && failure.code === 'desktop_session_changed') {
          return { error: 'desktop_session_changed' }
        }
        if (status === 401) return { error: 'authRequired' }
        if (status === 403) return { error: 'issueAccessLost' }
        if (status === 409) return { error: 'issueOutdated' }
        const readback = await getIssue(issue.id).catch(() => null)
        if (readback?.error) return readback
        const latest = readback && 'issue' in readback ? readback.issue : undefined
        if (latest?.id !== issue.id || latest.revision <= issue.revision) return null
        if (patch.status && latest.status !== patch.status) return null
        if (patch.priority && latest.priority !== patch.priority) return null
        if (patch.block && (latest.metadata.block?.blocked !== patch.block.blocked || latest.metadata.block.runId !== patch.block.runId)) return null
        verifiedByRead = true
        return readback
      })
      if (!result || !('issue' in result) || !result.issue) {
        setColumns(rollback)
        const errorMessage = !result ? t('saveUnconfirmed') : result.error === 'desktop_session_changed'
          ? tTransport('desktop_session_changed.default') : translateError(result.error)
        setMessage(errorMessage)
        toast.error(errorMessage, { id: errorToastId })
        return false
      }
      const savedIssue = result.issue
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, status: savedIssue.status, priority: savedIssue.priority, metadata: savedIssue.metadata, revision: savedIssue.revision, updatedAt: savedIssue.updatedAt } : item)])))
      const status = patch.block?.blocked ? BLOCKED_COLUMN : patch.status
      if (verifiedByRead) setMessage(t('changeVerified'))
      else if (status) setMessage(t('moved', { status: statusLabel(status) }))
      else setMessage(patch.priority ? t('prioritySaved') : t('propertiesSaved'))
      return true
    } finally {
      saving.current = false
      setPending(false)
      onBusyChange(false)
      void onUpdated().catch(() => {})
    }
  }

  function changeStatus(issue: Issue, status: IssueStatus) {
    if (saving.current || dragging || issue.status === status) return
    const target = boardColumnOf(status, blocks.has(issue.id))
    const next = Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, key === target ? [{ ...issue, status }, ...items.filter(item => item.id !== issue.id)] : items.filter(item => item.id !== issue.id)]))
    setColumns(next)
    setMotion(issue.id, 'enter')
    window.setTimeout(() => setMotion(issue.id, null), CARD_MOTION_MS * 2)
    void persist(issue, { status }, columns)
  }

  /** 受阻 by hand, from the card's menu: in, or out to its own status column. */
  function changeBlock(issue: Issue, blocked: boolean) {
    if (saving.current || dragging) return
    const target = blocked ? BLOCKED_COLUMN : boardColumnOf(issue.status)
    const next = Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, key === target ? [issue, ...items.filter(item => item.id !== issue.id)] : items.filter(item => item.id !== issue.id)]))
    setColumns(next)
    setMotion(issue.id, 'enter')
    window.setTimeout(() => setMotion(issue.id, null), CARD_MOTION_MS * 2)
    void persist(issue, { block: blocked ? FLAGGED_BLOCK : clearedBlock(runOf(issue)) }, columns)
  }
  const runOf = (issue: Issue) => { const runId = newestRuns.get(issue.id); return runId ? { runId } : undefined }

  function changePriority(issue: Issue, priority: string) {
    if (saving.current || dragging || issue.priority === priority) return
    setColumns(Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, items.map(item => item.id === issue.id ? { ...item, priority } : item)])))
    void persist(issue, { priority }, columns)
  }

  async function remove(issue: Issue) {
    if (saving.current) return
    saving.current = true
    setPending(true)
    onBusyChange(true)
    setMotion(issue.id, 'leave')
    try {
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(resolve => window.setTimeout(resolve, CARD_MOTION_MS))
      const result = await setIssueDeleted({ id: issue.id, revision: issue.revision })
      if (result.error) {
        toast.error(translateError(result.error))
        return
      }
      setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.filter(item => item.id !== issue.id)])))
      let restoring = false
      async function restore() {
        if (restoring) return
        restoring = true
        try {
          const restored = await setIssueDeleted({ id: issue.id, restore: true })
          if (restored.error) toast.error(translateError(restored.error))
        } catch {
          toast.error(tDetail('restoreViaLinkFailed'))
        } finally {
          restoring = false
          void onUpdated().catch(() => {})
        }
      }
      toast(t('deleted', { title: issue.title }), { action: { label: t('undo'), onClick: () => { void restore() } } })
    } catch {
      toast.error(t('deleteFailed'))
    } finally {
      setMotion(issue.id, null)
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
    void save(issue, meta.activeContainer, meta.overContainer, meta.previousValue)
  }
  // Into 受阻: the task keeps its status and is flagged. Out of it: its new status, and what blocked it is set aside.
  function save(issue: Issue, from: string, to: string, rollback: Columns) {
    if (to === BLOCKED_COLUMN) return persist(issue, { block: FLAGGED_BLOCK }, rollback)
    if (from === BLOCKED_COLUMN) return persist(issue, { status: to, block: clearedBlock(runOf(issue)) }, rollback)
    return persist(issue, { status: to }, rollback)
  }
  /** A card dropped into another column without dnd-kit (a UI layer's own board): moved at once, then saved. */
  async function moveTo(id: string, to: string) {
    if (saving.current) return false
    const from = Object.keys(columns).find(key => columns[key]?.some(item => item.id === id))
    const issue = from ? columns[from]?.find(item => item.id === id) : undefined
    if (!issue || !from || from === to || !(to in columns)) return false
    setColumns(Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, key === to ? [issue, ...items] : items.filter(item => item.id !== id)])))
    return save(issue, from, to, columns)
  }
  function metadataBusy(busy: boolean) { saving.current = busy; setPending(busy); onBusyChange(busy) }
  function metadataSaved(savedIssue: MetadataSavedIssue) {
    setColumns(current => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, items.map(item => item.id === savedIssue.id ? { ...item, metadata: savedIssue.metadata, revision: savedIssue.revision, updatedAt: savedIssue.updatedAt } : item)])))
    setMessage(t('propertiesSaved'))
    void onUpdated().catch(() => {})
  }
  return { columns, setColumns, pending, dragging, setDragging, message, cardMotion, saving, changeStatus, changeBlock, changePriority, remove, commit, moveTo, metadataBusy, metadataSaved }
}

export function IssueBoard({ issues, blocks = new Map(), newestRuns = new Map(), columns: visibleColumns, hidden, sidebarOpen, context, onOpen, onDiscuss, onHideColumn, onShowColumn, onUpdated, onBusyChange, stateKey = 'board' }: { stateKey?: string;
  issues: Issue[]
  /** Each 受阻 task's reason (lib/task-blocked.ts); its card is in the 受阻 column. */
  blocks?: ReadonlyMap<string, TaskBlock>
  /** Each task's newest thread: moving a card out of 受阻 sets that thread's reason aside. */
  newestRuns?: ReadonlyMap<string, string>
  columns: BoardColumn[]
  hidden: { status: BoardColumn; count: number }[]
  sidebarOpen?: boolean
  context: CardContext
  onOpen: (id: string) => void
  onDiscuss: (issue: Issue) => void
  onHideColumn: (status: BoardColumn) => void
  onShowColumn: (status: BoardColumn) => void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Board')
  const { columns, setColumns, pending, setDragging, message, cardMotion, saving, changeStatus, changeBlock, changePriority, remove, commit, metadataBusy, metadataSaved } = useIssueBoardSaves({ issues, blocks, newestRuns, onUpdated, onBusyChange })
  const viewportRef = useViewScroll<HTMLDivElement>(`${stateKey}:horizontal`)
  const [visited, setVisited] = useViewState(`${stateKey}:visited`, false)
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

  // Open on the first column with a task when the ones before it are empty (N5), once, before the person scrolls.
  const started = useRef<string | null>(null)
  useEffect(() => {
    const viewport = viewportRef.current
    if (started.current === stateKey || visited || !viewport || !issues.length) return
    started.current = stateKey
    setVisited(true)
    const shown = BOARD_COLUMNS.map(column => column.value).filter(value => visibleColumns.includes(value as IssueStatus))
    const target = boardStartColumn(shown, Object.fromEntries(Object.entries(columns).map(([key, items]) => [key, items.length])))
    const element = target && viewport.querySelector<HTMLElement>(`[data-slot="kanban-column"][data-value="${CSS.escape(target)}"]`)
    if (!element) return
    const left = boardScrollTo(element.getBoundingClientRect(), viewport.getBoundingClientRect(), viewport.scrollLeft)
    if (left !== null) viewport.scrollTo({ left, behavior: 'instant' })
  }, [issues.length, columns, visibleColumns, visited, setVisited, viewportRef, stateKey])

  function scrollBoard(direction: -1 | 1) {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * Math.min(viewport.clientWidth * 0.8, 340), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  return <section aria-label={t('label')} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <p role="status" aria-live="polite" className="sr-only">{message}</p>
    <p id={instructionsId} className="sr-only">{t('keyboardHint')}</p>
    <KanbanBoard stateKey={stateKey} value={columns} columns={visibleColumns} hiddenColumns={hidden} sidebarOpen={sidebarOpen} context={cardMotion.size ? { ...context, motion: cardMotion } : context} onDelete={issue => { void remove(issue) }} onBlockChange={changeBlock} onDiscuss={onDiscuss} onHideColumn={onHideColumn} onShowColumn={onShowColumn} onValueChange={setColumns} onValueCommit={commit} restoreOnCancel pending={pending} onOpen={onOpen} onStatusChange={changeStatus} onPriorityChange={changePriority} onMetadataBusy={metadataBusy} onMetadataSaved={metadataSaved} viewportRef={viewportRef} viewportId={viewportId} instructionsId={instructionsId} onViewportKeyDown={event => {
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
