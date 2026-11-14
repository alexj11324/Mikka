'use client'

import { Component, useCallback, type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { useTranslations } from 'next-intl'
import type { JSONContent } from '@tiptap/react'
import { ArrowLeft } from 'lucide-react'
import type { IssueDetailNavigation } from './issue-detail-header'
import type { IssueActionRequest } from './issue-detail-actions'
import { IssueDescriptionHistory } from './issue-description-history'
import type { MetadataRequest } from './issue-metadata-controls'
import { toast } from 'sonner'
import { getDeletedIssue, setIssueDeleted } from '@/app/actions/issue-operations'
import { pollIssue, pollIssueVersionSummaries, saveIssue, listIssueVersions, type IssueView } from '@/app/actions/issues'
import { CacheReadError } from '@/lib/cache-read-error'
import { readAccessFailure, waitForCacheHydration } from '@/lib/swr/persistent-cache'
import { isTaskPresentationKey, issueKeys } from '@/lib/swr/keys'
import { ListReadScopeError } from '@/lib/live/list-read'
import { heldListPositions, mergeList, type ListSnapshot } from '@/lib/list-poll'
import { IssueEditor, createDocumentSeed, type IssueDiscussions } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { useActionError } from '@/lib/use-action-error'
import { IssueMembers } from './issue-members'
import { useAgentActivity } from './issue-threads'
import { FramedTask } from './task-detail-frame'
import { TaskThreadPane } from './task-thread-pane'
import { navigate } from './workspace-navigation'
import { FactoryAcceptance, FactoryAcceptancePanel, type FactoryTask } from './factory-acceptance'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useViewState } from '@/lib/hooks/view-state'
import { closeOnEscape, useFocusReturn } from '@/hooks/use-focus-return'
import { TaskDetailFrame } from '@ui-slot/task-detail'

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
  const { cache, mutate: mutateCache } = useSWRConfig()
  const publishSaved = useCallback((issue: Issue, previousStatus: Issue['status']) => {
    // A confirmed write also updates the preview that another placement opens immediately.
    // Discard the old conditional token. A slower mutation must never move the cache backwards.
    void mutateCache<IssueRead>(issueKeys.detail(issue.id), previous =>
      previous && previous.revision > issue.revision ? previous : issue, { revalidate: false })
    if (previousStatus !== issue.status) {
      void mutateCache(key => isTaskPresentationKey(key, user.id, issue.workspaceId, issue.id))
    }
    onSaved(issue.id)
  }, [mutateCache, onSaved, user.id])
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
  // The open thread resizes from its left edge.
  const threadWidth = useResizableWidth({ storageKey: 'mikka:task-thread-width', min: 360, max: 720, initial: 432, edge: 'start' })
  const tCommon = useTranslations('Common')
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusReturn(initial.id, rootRef)
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
  const hasUnsavedChanges = dirty || syncState.pending
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
          const previous = savedRef.current
          const revision = previous.revision
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
            publishSaved(result.issue, previous.status)
          }
        } while (draft.current.generation !== acknowledged.current)
        return true
      } catch { setError(saveMessages.current.t('autosaveFailed')); return false }
      finally { setPending(false) }
    })()
    flight.current = operation
    void operation.finally(() => { flight.current = null })
    return operation
  }, [initial.id, locked, sync, publishSaved, refreshVersions])
  useEffect(() => {
    // A preview cannot acquire an editable draft, so leaving it needs no save.
    // Keep save() itself refused until the normal read verifies access.
    onRegisterFlush(locked ? () => Promise.resolve(true) : save)
    return () => onRegisterFlush(null)
  }, [onRegisterFlush, locked, save])
  useEffect(() => {
    // Comments, replies and resolves update the discussion map without changing the editor body.
    if ((!editSequence && !syncState.pending) || !syncState.ready || syncState.error) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [editSequence, syncState.ready, syncState.pending, syncState.error, save])
  function adopt(issue: Issue) {
    if (issue.revision < savedRef.current.revision) return
    const previousStatus = savedRef.current.status
    savedRef.current = issue; setSaved(issue); setStatus(issue.status); setPriority(issue.priority)
    draft.current = { ...draft.current, status: issue.status, priority: issue.priority }
    void refreshVersions().catch(() => {}); publishSaved(issue, previousStatus)
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
  const threadPanel = preview ? null : openThread
    ? <TaskThreadPane issueId={saved.id} runId={openThread} tab={threadTab} onOpenThread={showThread} onBack={() => showThread(null)} />
    : openAcceptance && <FactoryAcceptancePanel key={openAcceptance.id} task={openAcceptance} onOpenThread={showThread} onClose={() => setOpenAcceptance(null)} />

  const saveLabel = readOnly || locked ? '' : error ? t('saveFailed') : syncState.error ? t('syncFailed') : pending || metadataSaving ? t('saving') : t('autosaved')
  const acceptance = preview ? null : <FactoryAcceptance issueId={saved.id} onOpen={showAcceptance} onOpenThread={showThread} />
  // The frame composes sub-tasks and activity around the shared document editor.
  const editorWith = (afterDescription: ReactNode, renderActivity: (discussions: IssueDiscussions) => ReactNode) => <>
    {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />{t('backToSimple')}</Button></div>}
    <SectionBoundary onClose={onClose}>{syncState.ready || readOnly || locked ? <>{readOnly && <Alert><AlertDescription>{t('invalidContentReadOnly')}</AlertDescription></Alert>}<IssueEditor persisted issueId={preview ? undefined : saved.id} key={reader ? String(initial.updatedAt) : undefined} content={reader ? initial.content : content} readOnlyDiscussions={reader ? initial.readOnlyDiscussions : undefined} disabled={readOnly || locked} layout={documentTools ? 'document' : 'issue'} renderActivity={renderActivity} afterDescription={preview ? null : afterDescription} sharedDoc={sync?.doc} author={user.name || user.email} authorId={user.id} replacement={replacement} onReplacementApplied={replacementApplied} syncLabel={readOnly || locked ? '' : syncState.error ? t('syncFailedLabel') : t('syncedLabel')} onChange={descriptionChanged} /></> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>{t('retrySync')}</Button>}</div>}</SectionBoundary>
  </>
  const dialogs = <>
    <Dialog open={members} onOpenChange={setMembers}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t('membersTitle')}</DialogTitle><DialogDescription>{tDetail('membersDialogDescription')}</DialogDescription></DialogHeader><IssueMembers id={saved.id} onChanged={async () => { adopt(await loadIssue(saved.id, user.id)) }} /></DialogContent></Dialog>
    <IssueDescriptionHistory open={history} onOpenChange={setHistory} identifier={saved.identifier} title={title} currentContent={content} versions={historyVersions} loadingError={!!historyBodyError} onRetry={() => { void refreshHistoryVersions() }} onRestore={restore} />
  </>
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => closeOnEscape(event, rootRef.current, onClose)
  const titleChange = (value: string) => changed({ title: value })
  const titleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }
  return <FramedTask Frame={TaskDetailFrame} rootRef={rootRef} onKeyDown={onKeyDown} label={title || t('titleLabel')} preview={preview} locked={locked} origin={origin} navigation={navigation} onClose={onClose} onOpen={onOpen} onDeleted={onDeleted} userId={user.id}
    task={saved} title={title} status={status} priority={priority} liveWorkspaceId={liveWorkspaceId} saveLabel={saveLabel} saved={!error && !syncState.error && !pending && !metadataSaving}
    discussionSave={sync ? { afterAcknowledged: sync.afterAcknowledged, retry: () => { void save() } } : undefined}
    titleField={{ value: title, label: t('titleLabel'), readOnly: locked, maxLength: 200, onChange: titleChange, onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false; setEditSequence(value => value + 1) }, onBlur: () => { if (title.trim() && title !== saved.title) void save() }, onKeyDown: titleKeyDown }}
    saveError={error ? { text: error, retry: t('retryAutosave'), onRetry: () => { void save() }, busy: pending } : null} syncNotice={syncState.error ? t('syncRetryNotice') : null}
    editor={(afterDescription, renderActivity) => editorWith(afterDescription, renderActivity)} acceptance={acceptance}
    versions={versions ?? []} historyFailed={historyError ? () => { void refreshVersions() } : null} agentActivity={agentActivity}
    documentTools={documentTools} actionRequest={actionRequest} propertyRequest={propertyRequest} requestAction={requestAction} requestProperty={requestProperty} getCurrent={getCurrent} adopt={adopt} onMetadataBusy={setMetadataSaving}
    onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }}
    onHistory={() => { void save().then(success => { if (success) setHistory(true) }) }} onMembers={() => setMembers(true)} onDocumentTools={() => setDocumentTools(value => !value)}
    panel={threadPanel || null} wide={wide} resize={{ handle: wide && threadPanel ? <ResizeHandle resize={threadWidth} label={tCommon('resize.taskPanel')} edge="start" /> : null, width: threadWidth.width, dragging: threadWidth.dragging }} dialogs={dialogs} />

}
