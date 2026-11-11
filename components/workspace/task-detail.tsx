'use client'

import { Component, useCallback, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { useTranslations } from 'next-intl'
import type { JSONContent } from '@tiptap/react'
import { ArrowLeft } from 'lucide-react'
import { IssueDetailHeader, type IssueDetailNavigation } from './issue-detail-header'
import { IssueDetailActions, type IssueActionRequest } from './issue-detail-actions'
import { IssueDescriptionHistory } from './issue-description-history'
import { IssueRelations } from './issue-relations'
import type { MetadataRequest } from './issue-metadata-controls'
import { toast } from 'sonner'
import { getDeletedIssue, listIssueConnections, setIssueDeleted } from '@/app/actions/issue-operations'
import { pollIssue, pollIssueVersionSummaries, saveIssue, listIssueVersions, type IssueView } from '@/app/actions/issues'
import { CacheReadError } from '@/lib/cache-read-error'
import { readAccessFailure, waitForCacheHydration } from '@/lib/swr/persistent-cache'
import { issueKeys } from '@/lib/swr/keys'
import { ListReadScopeError } from '@/lib/live/list-read'
import { heldListPositions, mergeList, type ListSnapshot } from '@/lib/list-poll'
import { IssueEditor, createDocumentSeed, type IssueDiscussions } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { useActionError } from '@/lib/use-action-error'
import { IssueMembers } from './issue-members'
import { IssueDetailProperties } from './issue-detail-properties'
import { useAgentActivity } from './issue-threads'
import { FramedTask } from './task-detail-frame'
import { TaskThreadPane } from './task-thread-pane'
import { navigate } from './workspace-navigation'
import { cn } from '@/lib/utils'
import { FactoryAcceptance, FactoryAcceptancePanel, type FactoryTask } from './factory-acceptance'
import { IssueActivityFeed } from './issue-activity-feed'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useViewState } from '@/lib/hooks/view-state'
import { closeOnEscape, useFocusReturn } from '@/hooks/use-focus-return'
import * as detailSlot from '@ui-slot/task-detail'

// A layer's task page (docs/ui-overlay.md); without one, the community layout below.
const Frame = detailSlot.TaskDetailFrame ?? null

type Issue = IssueView
type IssueRead = IssueView & { readVersion?: string }
type ActivityRead = ListSnapshot<Awaited<ReturnType<typeof listIssueVersions>>[number]>

// No access and deleted come back as an action error; SWR's error state renders UnavailableIssue.
async function loadIssue(id: string, viewerId: string, previous?: IssueRead): Promise<IssueRead> {
  const result = await pollIssue(id, previous?.readVersion)
  if (result.error) throw new CacheReadError(result.error)
  if (result.viewerId !== viewerId) throw new ListReadScopeError('owner')
  if (result.unchanged) return { ...previous!, readVersion: result.version }
  return { ...result.issue, readVersion: result.version }
}
type WorkspaceUser = { id: string; name: string; email: string }
type DetailProps = { /** The thread open in the right column, from the address (R-82). */ thread: string | null; /** Where the task was opened from: the first crumb. */ origin: string; navigation: IssueDetailNavigation; onOpen: (id: string) => void; user: WorkspaceUser; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void; onDeleted: () => void; onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void }

function UnavailableIssue({ id, onRetry, onClose }: { id: string; onRetry: () => void; onClose: () => void }) {
  const t = useTranslations('IssueDetail')
  const actionError = useActionError()
  const { data } = useSWR(issueKeys.deleted(id), () => getDeletedIssue(id))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return <div className="flex flex-col items-start gap-4 p-8"><h1 className="text-lg font-semibold">{data ? t('deletedTitle') : t('unavailableTitle')}</h1><p role="status" className="text-sm text-muted-foreground">{data ? t('deletedDescription', { title: data.title }) : t('unavailableDescription')}</p>{error && <FieldError>{error}</FieldError>}<div className="flex gap-2">{data && <Button disabled={pending} onClick={async () => { setPending(true); try { const result = await setIssueDeleted({ id, restore: true }); if (result.error) setError(actionError(result.error)); else { toast.success(t('taskRestored')); onRetry() } } catch { setError(t('restoreFailed')) } finally { setPending(false) } }}>{t('restoreTask')}</Button>}<Button size="sm" variant="outline" onClick={onRetry}>{t('reload')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('backToWorkspace')}</Button></div></div>
}

const WIDE = '(min-width: 1024px)'
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function TaskDetail({ id, ...props }: DetailProps & { id: string }) {
  const t = useTranslations('Workspace.detail')
  const { cache } = useSWRConfig()
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const key = issueKeys.detail(id)
  const { data, error, mutate } = useSWR<IssueRead>(key, async () => {
    await waitForCacheHydration(cache)
    const previous = cache.get(unstable_serialize(key))?.data as IssueRead | undefined
    return loadIssue(id, props.user.id, previous?.id === id ? previous : undefined)
  }, { revalidateOnFocus: false, revalidateOnMount: false, onSuccess: () => setLoadedId(id) })
  useEffect(() => {
    let active = true
    setLoadedId(null)
    // A rapid reopen can reuse SWR's previous request without this instance's
    // onSuccess. Start a fresh authorized read after hydration, even when the
    // previous instance still has an in-flight request. Only onSuccess unlocks
    // the form: mutate can resolve with old cache data when a read is refused.
    void waitForCacheHydration(cache).then(() => active ? mutate() : undefined).catch(() => {})
    return () => { active = false }
  }, [cache, id, mutate, props.user.id])
  const unavailable = error instanceof CacheReadError || error instanceof ListReadScopeError || !!readAccessFailure(error)
  // A refusal retires this mount's authorization; a later transport failure
  // cannot make its old cached document writable again.
  useEffect(() => {
    if (unavailable) { setLoadedId(null); props.onDirty(false) }
  }, [unavailable, props.onDirty])
  const backgroundFailed = Boolean(error && data && loadedId === id && !unavailable)
  const readFailedMessage = t('readFailed'), retryLabel = t('reload')
  useEffect(() => {
    const notice = `issue-detail-read-${id}`
    if (backgroundFailed) toast.error(readFailedMessage, { id: notice, duration: Infinity, action: { label: retryLabel, onClick: event => { event.preventDefault(); void mutate() } } })
    else toast.dismiss(notice)
    return () => { toast.dismiss(notice) }
  }, [backgroundFailed, id, mutate, readFailedMessage, retryLabel])
  if (error && !backgroundFailed) return <UnavailableIssue id={id} onRetry={() => { void mutate() }} onClose={props.onClose} />
  if (!data) return <div role="status" aria-label={t('reading')} className="mx-auto flex w-full max-w-170 flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
  // Show a local snapshot immediately, but do not seed a writable Y.Doc from
  // it before the normal read rechecks access and the current body fingerprint.
  return <SectionBoundary key={id} onClose={props.onClose}><TaskForm key={loadedId !== id ? 'cached' : data.canSteer === false ? 'reader' : 'editor'} initial={data} preview={loadedId !== id} {...props} /></SectionBoundary>
}

function SectionBoundary({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const t = useTranslations('Workspace.detail')
  const tDetail = useTranslations('IssueDetail')
  const [attempt, setAttempt] = useState(0)
  return <EditorErrorBoundary key={attempt} title={t('editorCrashedTitle')} description={t('editorCrashedDescription')} retryLabel={t('editorCrashedRetry')} closeLabel={tDetail('backToWorkspace')} onRetry={() => setAttempt(value => value + 1)} onClose={onClose}>{children}</EditorErrorBoundary>
}

class EditorErrorBoundary extends Component<{ children: ReactNode; title: string; description: string; retryLabel: string; closeLabel: string; onRetry: () => void; onClose: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error('Task description failed', error instanceof Error ? error.message : error) }
  render() {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="flex flex-col items-start gap-4 p-8"><h1 className="text-lg font-semibold">{this.props.title}</h1><p className="text-sm text-muted-foreground">{this.props.description}</p><div className="flex gap-2"><Button size="sm" onClick={this.props.onRetry}>{this.props.retryLabel}</Button><Button size="sm" variant="ghost" onClick={this.props.onClose}>{this.props.closeLabel}</Button></div></div>
  }
}

const READ_ONLY_SNAPSHOT = { ready: false, pending: false, error: false, syncing: false, workspaceId: null }
const readOnlySnapshot = () => READ_ONLY_SNAPSHOT
const noSubscribe = () => () => {}

function TaskForm({ initial, preview = false, thread: openThread, origin, user, onSaved, onDirty, onClose, onDeleted, onRegisterFlush, navigation, onOpen }: DetailProps & { initial: Issue; preview?: boolean }) {
  const t = useTranslations('Workspace.detail')
  const { cache } = useSWRConfig()
  const tDetail = useTranslations('IssueDetail')
  const actionError = useActionError()
  const saveMessages = useRef({ t, actionError })
  saveMessages.current = { t, actionError }
  const [saved, setSaved] = useState(initial)
  // Content the editor schema rejects opens read-only: no seed is sent and nothing syncs, so the stored body is never overwritten.
  const [seed] = useState(() => createDocumentSeed(initial.content, initial.id))
  const reader = initial.canSteer === false
  const locked = preview || reader
  const readOnly = seed === null
  // Read-only never constructs a DocumentSync: no Y.Doc, no provider, no exchange.
  const [sync] = useState(() => seed && !locked ? new DocumentSync(initial.id, seed) : null)
  const syncState = useSyncExternalStore(sync?.subscribe ?? noSubscribe, sync?.getSnapshot ?? readOnlySnapshot, sync?.getSnapshot ?? readOnlySnapshot)
  const liveWorkspaceId = syncState.workspaceId ?? (reader ? initial.workspaceId : null)
  const syncKey = sync ? issueKeys.document(saved.id, sync.doc.clientID) : null
  const { mutate: retrySync } = useSWR(syncKey, () => sync?.exchange(saved.id), { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  // A committed acceptance changes the issue and its history without editing
  // the Yjs body. All three reads follow the same authorized document event.
  useLiveKey('issue_document', sync || reader ? saved.id : null, [...(syncKey ? [unstable_serialize(syncKey)] : []), unstable_serialize(issueKeys.detail(saved.id)), unstable_serialize(issueKeys.versions(saved.id)), unstable_serialize(issueKeys.activityVersions(saved.id))], liveWorkspaceId, { minIntervalMs: 1500 })
  useEffect(() => {
    // Delay disposal so React Strict Mode's immediate effect replay retains this document.
    if (!sync) return
    const holder = sync as DocumentSync & { disposal?: ReturnType<typeof setTimeout> }
    clearTimeout(holder.disposal)
    return () => { holder.disposal = setTimeout(() => sync.destroy(), 0) }
  }, [sync])
  const [title, setTitle] = useState(initial.title)
  const [content, setContent] = useState<JSONContent>(initial.content)
  const [status, setStatus] = useState(initial.status)
  const [priority, setPriority] = useState(initial.priority)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const flight = useRef<Promise<boolean> | null>(null)
  const draft = useRef({ title: initial.title, content: initial.content, status: initial.status, priority: initial.priority, generation: 0 })
  const savedRef = useRef(initial)
  const acknowledged = useRef(0)
  const composing = useRef(false)
  const [editSequence, setEditSequence] = useState(0)
  const [metadataSaving, setMetadataSaving] = useState(false)
  // 验收 opens on the thread that produced the candidate (Figma 357:4750, frame 06); a task with no known thread opens alone.
  const [threadTab, setThreadTab] = useState<'chat' | 'acceptance'>('chat')
  const [openAcceptance, setOpenAcceptance] = useState<FactoryTask | null>(null)
  // The open thread is the address's (?thread=), so back closes it and a link reopens it beside this task (R-82).
  const showThread = useCallback((runId: string | null) => { setOpenAcceptance(null); setThreadTab('chat'); navigate({ thread: runId }) }, [])
  const agentActivity = useAgentActivity(saved.id, openThread ?? null, showThread, !preview)
  const showAcceptance = useCallback((task: FactoryTask) => {
    if (task.candidateRunId) { setOpenAcceptance(null); setThreadTab('acceptance'); navigate({ thread: task.candidateRunId }) }
    else { navigate({ thread: null }); setOpenAcceptance(task) }
  }, [])
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false)
  // The right column resizes from its left line (decision 2026-11-01-1310); an open thread and the properties keep their own widths.
  const threadWidth = useResizableWidth({ storageKey: 'mikka:task-thread-width', min: 360, max: 720, initial: 432, edge: 'start' })
  const propertiesWidth = useResizableWidth({ storageKey: 'mikka:task-properties-width', min: 260, max: 480, initial: 320, edge: 'start' })
  const tCommon = useTranslations('Common')
  const panelRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusReturn(initial.id, rootRef)
  const panelWidth = (openThread || openAcceptance ? threadWidth : propertiesWidth).width
  useLayoutEffect(() => { panelRef.current?.style.setProperty('--task-panel-width', `${panelWidth}px`) })
  const [error, setError] = useState('')
  const [history, setHistory] = useState(false)
  const [members, setMembers] = useState(false)
  const [documentTools, setDocumentTools] = useViewState(`task:${initial.id}:document-tools`, false)
  const [propertyRequest, setPropertyRequest] = useState<MetadataRequest | null>(null)
  const [actionRequest, setActionRequest] = useState<IssueActionRequest | null>(null)
  const restoration = useRef<{ resolve: (success: boolean) => void } | null>(null)
  const [replacement, setReplacement] = useState<{ content: JSONContent; version: number }>()
  const activityKey = issueKeys.activityVersions(saved.id)
  const { data: activityRead, error: historyError, mutate: refreshVersions } = useSWR<ActivityRead>(preview ? null : activityKey, async () => {
    await waitForCacheHydration(cache)
    const previous = cache.get(unstable_serialize(activityKey))?.data as ActivityRead | undefined
    const held = heldListPositions(previous)
    const known = held && held.length === previous?.positions?.length ? previous?.version : undefined
    const result = await pollIssueVersionSummaries(saved.id, known, held)
    if (result.error) throw new CacheReadError(result.error)
    if (result.viewerId !== user.id) throw new ListReadScopeError('owner')
    const next = result.snapshot
    return { version: next.version, items: mergeList(previous?.items ?? [], next), positions: 'positions' in next ? next.positions : previous?.positions }
  })
  const versions = activityRead?.items
  const { data: historyVersions, error: historyBodyError, mutate: refreshHistoryVersions } = useSWR(history && !preview ? issueKeys.versions(saved.id) : null, () => listIssueVersions(saved.id))
  const { data: connections } = useSWR(preview ? null : issueKeys.connections(saved.id), () => listIssueConnections(saved.id))
  useEffect(() => {
    const previous = savedRef.current
    if (initial.id !== previous.id || initial.revision <= previous.revision) return
    const current = draft.current
    const next = { ...current }
    // Only fields unchanged since the last server snapshot adopt its newer
    // value. Updating the draft too keeps a later text save from reopening Done.
    if (current.title === previous.title && !composing.current) { next.title = initial.title; setTitle(initial.title) }
    if (current.status === previous.status) { next.status = initial.status; setStatus(initial.status) }
    if (current.priority === previous.priority) { next.priority = initial.priority; setPriority(initial.priority) }
    if (JSON.stringify(current.content) === JSON.stringify(previous.content)) { next.content = initial.content; setContent(initial.content) }
    draft.current = next
    savedRef.current = initial
    setSaved(initial)
    // This is a read, not an edit: keep generation, selection and the Y.Doc.
  }, [initial])
  const hasUnsavedChanges = dirty
  useEffect(() => { onDirty(hasUnsavedChanges || pending) }, [hasUnsavedChanges, pending, onDirty])
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [hasUnsavedChanges])
  function changed(patch: Partial<Pick<Issue, 'title' | 'content' | 'status' | 'priority'>>) {
    if (locked) return
    draft.current = { ...draft.current, ...patch, generation: draft.current.generation + 1 }
    if (patch.title !== undefined) setTitle(patch.title)
    if (patch.content !== undefined) setContent(patch.content)
    if (patch.status !== undefined) setStatus(patch.status)
    if (patch.priority !== undefined) setPriority(patch.priority)
    setDirty(true)
    setError('')
    setEditSequence(value => value + 1)
  }
  const save = useCallback((): Promise<boolean> => {
    if (locked) return Promise.resolve(false)
    if (flight.current) return flight.current
    if (composing.current) return Promise.resolve(false)
    const operation = (async () => {
      const mustPersist = () => draft.current.generation !== acknowledged.current
      if (!mustPersist() && !sync?.getSnapshot().pending) return true
      if (mustPersist()) setPending(true)
      setError('')
      try {
        do {
          const snapshot = { ...draft.current }
          const revision = savedRef.current.revision
          if (!snapshot.title.trim()) { setError(saveMessages.current.t('titleRequired')); return false }
          const yjs = sync?.getSnapshot() ?? readOnlySnapshot()
          const bodyDirty = JSON.stringify(snapshot.content) !== JSON.stringify(savedRef.current.content)
          if (sync && (yjs.pending || bodyDirty) && yjs.ready) await sync.flush(initial.id)
          else if (bodyDirty && !yjs.ready) { setError(saveMessages.current.t('documentNotConnected')); return false }
          // A live update during the flush must be included in the next
          // snapshot, never paired with fields captured at an older revision.
          if (savedRef.current.revision !== revision) continue
          if (snapshot.generation !== acknowledged.current) {
            const result = await saveIssue({ id: initial.id, revision, title: snapshot.title, content: snapshot.content, status: snapshot.status, priority: snapshot.priority })
            if (!('issue' in result) || !result.issue) { setError(saveMessages.current.actionError(result.error ?? 'issueSaveFailed')); return false }
            if (result.issue.revision >= savedRef.current.revision) {
              savedRef.current = result.issue
              setSaved(result.issue)
            }
            acknowledged.current = snapshot.generation
            setDirty(draft.current.generation !== acknowledged.current)
            void refreshVersions().catch(() => {})
            onSaved(result.issue.id)
          }
        } while (draft.current.generation !== acknowledged.current)
        return true
      } catch { setError(saveMessages.current.t('autosaveFailed')); return false }
      finally { setPending(false) }
    })()
    flight.current = operation
    void operation.finally(() => { flight.current = null })
    return operation
  }, [initial.id, locked, sync, onSaved, refreshVersions])
  useEffect(() => {
    // A preview cannot acquire an editable draft, so leaving it needs no save.
    // Keep save() itself refused until the normal read verifies access.
    onRegisterFlush(locked ? () => Promise.resolve(true) : save)
    return () => onRegisterFlush(null)
  }, [onRegisterFlush, locked, save])
  useEffect(() => {
    if (!editSequence || !syncState.ready) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [editSequence, syncState.ready, save])
  function adopt(issue: Issue) {
    if (issue.revision < savedRef.current.revision) return
    savedRef.current = issue; setSaved(issue); setStatus(issue.status); setPriority(issue.priority)
    draft.current = { ...draft.current, status: issue.status, priority: issue.priority }
    void refreshVersions().catch(() => {}); onSaved(issue.id)
  }
  async function getCurrent() { return await save() ? savedRef.current : null }
  async function restore(version: NonNullable<typeof historyVersions>[number]) {
    if (!await save()) return false
    return new Promise<boolean>(resolve => {
      restoration.current = { resolve }
      setReplacement(value => ({ content: version.content, version: (value?.version ?? 0) + 1 }))
    })
  }
  function descriptionChanged(value: JSONContent) {
    if (JSON.stringify(value) === JSON.stringify(draft.current.content)) return
    changed({ content: value })
  }
  function replacementApplied(applied: boolean) {
    const result = restoration.current
    restoration.current = null
    if (!result) return
    if (!applied) { result.resolve(false); return }
    queueMicrotask(() => { void save().then(success => { result.resolve(success); if (success) toast.success(tDetail('descriptionRestored')) }, () => result.resolve(false)) })
  }
  function requestAction(kind: IssueActionRequest['kind']) { setActionRequest(value => ({ kind, sequence: (value?.sequence ?? 0) + 1 })) }
  function requestProperty(target: MetadataRequest['target']) { setPropertyRequest(value => ({ target, sequence: (value?.sequence ?? 0) + 1 })) }
  const subtasks = (connections ?? []).filter(row => row.metadata.parentId === saved.id).map(row => ({ id: row.id, title: row.title, createdAt: row.createdAt }))
  const activity = preview ? null : <>
    {historyError && <Button variant="ghost" size="sm" type="button" onClick={() => { void refreshVersions() }}>{t('activityFailed')}</Button>}
    {agentActivity.error}
    <IssueActivityFeed versions={historyError ? [] : versions ?? []} children={historyError ? [] : subtasks} agents={agentActivity.rows} />
  </>

  const properties = <IssueDetailProperties task={saved} viewerId={user.id} onMetadataSaved={adopt} metadataDisabled={locked} onMetadataBusy={setMetadataSaving} status={status} priority={priority} pending={locked} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} request={propertyRequest} onDate={() => requestAction('dueDate')} onEstimate={() => requestAction('estimate')} relations={preview ? null : <IssueRelations liveWorkspaceId={liveWorkspaceId} viewerId={user.id} mode="sidebar" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={locked} />} />
  const threadPanel = preview ? null : openThread
    ? <TaskThreadPane issueId={saved.id} runId={openThread} tab={threadTab} onOpenThread={showThread} onBack={() => showThread(null)} />
    : openAcceptance && <FactoryAcceptancePanel key={openAcceptance.id} task={openAcceptance} onOpenThread={showThread} onClose={() => setOpenAcceptance(null)} />

  const saveLabel = readOnly || locked ? '' : error ? t('saveFailed') : syncState.error ? t('syncFailed') : pending || metadataSaving ? t('saving') : t('autosaved')
  const actions = <IssueDetailActions task={saved} userId={user.id} disabled={locked} documentTools={documentTools} request={actionRequest} getCurrent={getCurrent} onSaved={adopt} onOpen={onOpen} onDeleted={onDeleted} onHistory={() => { void save().then(success => { if (success) setHistory(true) }) }} onMembers={() => setMembers(true)} onDocumentTools={() => setDocumentTools(value => !value)} onProperty={requestProperty} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} />
  // No !important: Textarea ships `text-base md:text-sm`, and a variant-free `text-2xl` cannot beat `md:text-sm` at
  // >=768px, so the title states the size once per breakpoint (text-2xl md:text-2xl), as project-form.tsx does.
  // The rule it used to fight — the official layer holding phone form fields at 16px — is a `@media (max-width: 639px)`
  // rule on input/select/textarea from mikka-hosted-ui, and the layer draws this page's title with its own textarea,
  // not this one; below 640px this component's 24px already outranked it. task-09 (title larger than a body field) holds.
  const titleField = <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">{t('titleLabel')}</FieldLabel><Textarea id="task-title" readOnly={locked} aria-label={t('titleLabel')} rows={1} placeholder={t('titleLabel')} value={title} onChange={event => changed({ title: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; setEditSequence(value => value + 1) }} onBlur={() => { if (title.trim() && title !== saved.title) void save() }} maxLength={200} className="field-sizing-content min-h-10 w-full resize-none rounded-sm border-none bg-transparent px-0 py-0 text-2xl font-semibold tracking-tight shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:text-2xl dark:bg-transparent" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} /></Field></FieldGroup>
  const notice = error && <div className="flex flex-wrap items-center gap-2"><FieldError>{error}</FieldError><Button variant="outline" size="sm" disabled={pending} onClick={() => { void save() }}>{t('retryAutosave')}</Button></div>
  const acceptance = preview ? null : <FactoryAcceptance issueId={saved.id} onOpen={showAcceptance} onOpenThread={showThread} />
  // A layer that draws the page puts its own pieces under the description and draws 活动 itself (task-detail-frame.tsx).
  const editorWith = (afterDescription: ReactNode, renderActivity?: (discussions: IssueDiscussions) => ReactNode) => <>
    {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />{t('backToSimple')}</Button></div>}
    <SectionBoundary onClose={onClose}>{syncState.ready || readOnly || locked ? <>{readOnly && <Alert><AlertDescription>{t('invalidContentReadOnly')}</AlertDescription></Alert>}<IssueEditor persisted issueId={preview ? undefined : saved.id} key={reader ? String(initial.updatedAt) : undefined} content={reader ? initial.content : content} readOnlyDiscussions={reader ? initial.readOnlyDiscussions : undefined} disabled={readOnly || locked} layout={documentTools ? 'document' : 'issue'} activity={activity} renderActivity={renderActivity} afterDescription={preview ? null : afterDescription} sharedDoc={sync?.doc} author={user.name || user.email} authorId={user.id} replacement={replacement} onReplacementApplied={replacementApplied} syncLabel={readOnly || locked ? '' : syncState.error ? t('syncFailedLabel') : t('syncedLabel')} onChange={descriptionChanged} /></> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>{t('retrySync')}</Button>}</div>}</SectionBoundary>
  </>
  const editor = editorWith(<>{acceptance}<IssueRelations liveWorkspaceId={liveWorkspaceId} viewerId={user.id} mode="subissues" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={locked} /></>)
  const syncNotice = syncState.error && <FieldError className="text-xs">{t('syncRetryNotice')}</FieldError>
  const dialogs = <>
    <Dialog open={members} onOpenChange={setMembers}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t('membersTitle')}</DialogTitle><DialogDescription>{tDetail('membersDialogDescription')}</DialogDescription></DialogHeader><IssueMembers id={saved.id} onChanged={async () => { adopt(await loadIssue(saved.id, user.id)) }} /></DialogContent></Dialog>
    <IssueDescriptionHistory open={history} onOpenChange={setHistory} identifier={saved.identifier} title={title} currentContent={content} versions={historyVersions} loadingError={!!historyBodyError} onRetry={() => { void refreshHistoryVersions() }} onRestore={restore} />
  </>
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => closeOnEscape(event, rootRef.current, onClose)
  const titleChange = (value: string) => changed({ title: value })
  const titleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }
  if (Frame) return <FramedTask Frame={Frame} rootRef={rootRef} onKeyDown={onKeyDown} label={title || t('titleLabel')} preview={preview} locked={locked} origin={origin} navigation={navigation} onClose={onClose} onOpen={onOpen} onDeleted={onDeleted} userId={user.id}
    task={saved} title={title} status={status} priority={priority} liveWorkspaceId={liveWorkspaceId} saveLabel={saveLabel} saved={!error && !syncState.error && !pending && !metadataSaving}
    titleField={{ value: title, label: t('titleLabel'), readOnly: locked, maxLength: 200, onChange: titleChange, onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false; setEditSequence(value => value + 1) }, onBlur: () => { if (title.trim() && title !== saved.title) void save() }, onKeyDown: titleKeyDown }}
    saveError={error ? { text: error, retry: t('retryAutosave'), onRetry: () => { void save() }, busy: pending } : null} syncNotice={syncState.error ? t('syncRetryNotice') : null}
    editor={(afterDescription, renderActivity) => editorWith(afterDescription, renderActivity)} acceptance={acceptance}
    versions={versions ?? []} historyFailed={historyError ? () => { void refreshVersions() } : null} agentActivity={agentActivity}
    documentTools={documentTools} actionRequest={actionRequest} propertyRequest={propertyRequest} requestAction={requestAction} requestProperty={requestProperty} getCurrent={getCurrent} adopt={adopt} onMetadataBusy={setMetadataSaving}
    onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }}
    onHistory={() => { void save().then(success => { if (success) setHistory(true) }) }} onMembers={() => setMembers(true)} onDocumentTools={() => setDocumentTools(value => !value)}
    panel={threadPanel || null} wide={wide} resize={{ handle: wide && threadPanel ? <ResizeHandle resize={threadWidth} label={tCommon('resize.taskPanel')} edge="start" /> : null, width: threadWidth.width, dragging: threadWidth.dragging }} dialogs={dialogs} />


  // R-61: one line under the header, one before the properties or an open thread; the page scrolls, the right column stays.
  return <div ref={rootRef} tabIndex={-1} role="region" aria-busy={preview} aria-label={title || t('titleLabel')} className="flex min-w-0 flex-1 outline-none" onKeyDown={onKeyDown}>
    <div className="flex min-w-0 flex-1 flex-col">
    <IssueDetailHeader origin={origin} identifier={saved.identifier} title={title} saveLabel={saveLabel} saved={!error && !syncState.error && !pending && !metadataSaving} pending={false} navigation={navigation} onClose={onClose} actions={actions} />
    <div className="mx-auto flex w-full min-w-0 max-w-170 flex-1 flex-col gap-6 px-5 py-6 sm:px-8 lg:py-10">
      {!wide && <SectionBoundary onClose={onClose}>{properties}</SectionBoundary>}
      <div className="min-w-0">
        <div className="flex w-full flex-col gap-8">
          {notice}
          <div className="flex min-w-0 flex-col gap-7">
            {titleField}
            {editor}
          </div>
          {syncNotice}
        </div>
      </div>
    </div>
    </div>
    {/* One element for both widths: crossing the breakpoint restyles the open thread instead of remounting it (its tab, viewer and draft stay). */}
    {(wide || threadPanel) && <div ref={panelRef} className={cn(wide ? 'sticky top-0 flex h-[calc(100svh-3.25rem)] shrink-0 flex-col self-start border-l border-rule' : 'fixed inset-0 z-30 flex flex-col bg-background', (threadPanel ? threadWidth : propertiesWidth).dragging && 'select-none')}>
      {threadPanel ? <div className={cn('flex h-full flex-col', wide && 'w-(--task-panel-width)')}>{threadPanel}</div> : <div className="w-(--task-panel-width) overflow-y-auto px-6 py-10"><SectionBoundary onClose={onClose}>{properties}</SectionBoundary></div>}
      {wide && <ResizeHandle resize={threadPanel ? threadWidth : propertiesWidth} label={tCommon('resize.taskPanel')} edge="start" />}
    </div>}
    {dialogs}
  </div>
}
