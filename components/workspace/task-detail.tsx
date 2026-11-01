'use client'

import { Component, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import useSWR from 'swr'
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
import { getIssue, saveIssue, listIssueVersions, type IssueView } from '@/app/actions/issues'
import { IssueEditor, createDocumentSeed } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { useActionError } from '@/lib/use-action-error'
import { IssueMembers } from './issue-members'
import { IssueDetailProperties } from './issue-detail-properties'
import { IssueThreads, ThreadEvents } from './issue-threads'
import { IssueThreadPanel } from './issue-thread-panel'
import { cn } from '@/lib/utils'
import { FactoryAcceptance, FactoryAcceptancePanel, type FactoryTask } from './factory-acceptance'
import { IssueActivityFeed } from './issue-activity-feed'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

type Issue = IssueView

// No access and deleted come back as an action error; SWR's error state renders UnavailableIssue.
async function loadIssue(id: string) {
  const result = await getIssue(id)
  if (result.error) throw new Error(result.error)
  return result.issue
}
type WorkspaceUser = { id: string; name: string; email: string }
type DetailProps = { navigation: IssueDetailNavigation; workspaceName: string; onOpen: (id: string) => void; user: WorkspaceUser; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void; onDeleted: () => void; onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void }

function UnavailableIssue({ id, onRetry, onClose }: { id: string; onRetry: () => void; onClose: () => void }) {
  const t = useTranslations('IssueDetail')
  const actionError = useActionError()
  const { data } = useSWR(['deleted-issue', id], () => getDeletedIssue(id))
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
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const { data, error, mutate } = useSWR(['issue', id], () => loadIssue(id), { revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0, onSuccess: () => setLoadedId(id) })
  if (error) return <UnavailableIssue id={id} onRetry={() => { void mutate() }} onClose={props.onClose} />
  if (!data || loadedId !== id) return <div role="status" aria-label={t('reading')} className="mx-auto flex w-full max-w-170 flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
  return <SectionBoundary key={id} onClose={props.onClose}><TaskForm initial={data} {...props} /></SectionBoundary>
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

const READ_ONLY_SNAPSHOT = { ready: false, pending: false, error: false, syncing: false }
const readOnlySnapshot = () => READ_ONLY_SNAPSHOT
const noSubscribe = () => () => {}

function TaskForm({ initial, user, onSaved, onDirty, onClose, onDeleted, onRegisterFlush, navigation, onOpen, workspaceName }: DetailProps & { initial: Issue }) {
  const t = useTranslations('Workspace.detail')
  const tDetail = useTranslations('IssueDetail')
  const actionError = useActionError()
  const saveMessages = useRef({ t, actionError })
  saveMessages.current = { t, actionError }
  const [saved, setSaved] = useState(initial)
  // Content the editor schema rejects opens read-only: no seed is sent and nothing syncs, so the stored body is never overwritten.
  const [seed] = useState(() => createDocumentSeed(initial.content, initial.id))
  const readOnly = seed === null
  // Read-only never constructs a DocumentSync: no Y.Doc, no provider, no exchange.
  const [sync] = useState(() => seed ? new DocumentSync(initial.id, seed) : null)
  const syncState = useSyncExternalStore(sync?.subscribe ?? noSubscribe, sync?.getSnapshot ?? readOnlySnapshot, sync?.getSnapshot ?? readOnlySnapshot)
  const { mutate: retrySync } = useSWR(sync ? ['document-sync', saved.id, sync.doc.clientID] : null, () => sync?.exchange(saved.id), { refreshInterval: 1500, shouldRetryOnError: true, errorRetryInterval: 3000 })
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
  const [openThread, setOpenThread] = useState<string | null>(null)
  // 验收 opens on the thread that produced the candidate (Figma 357:4750, frame 06); a task with no known thread opens alone.
  const [threadTab, setThreadTab] = useState<'chat' | 'acceptance'>('chat')
  const [openAcceptance, setOpenAcceptance] = useState<FactoryTask | null>(null)
  const showThread = useCallback((runId: string | null) => { setOpenAcceptance(null); setThreadTab('chat'); setOpenThread(runId) }, [])
  const showAcceptance = useCallback((task: FactoryTask) => {
    if (task.candidateRunId) { setOpenAcceptance(null); setThreadTab('acceptance'); setOpenThread(task.candidateRunId) }
    else { setOpenThread(null); setOpenAcceptance(task) }
  }, [])
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState(false)
  const [members, setMembers] = useState(false)
  const [documentTools, setDocumentTools] = useState(false)
  const [propertyRequest, setPropertyRequest] = useState<MetadataRequest | null>(null)
  const [actionRequest, setActionRequest] = useState<IssueActionRequest | null>(null)
  const restoration = useRef<{ resolve: (success: boolean) => void } | null>(null)
  const [replacement, setReplacement] = useState<{ content: JSONContent; version: number }>()
  const { data: versions, error: historyError, mutate: refreshVersions } = useSWR(['versions', saved.id], () => listIssueVersions(saved.id), { revalidateOnFocus: false })
  const { data: connections } = useSWR(['issue-connections', saved.id], () => listIssueConnections(saved.id))
  const hasUnsavedChanges = dirty
  useEffect(() => { onDirty(hasUnsavedChanges || pending) }, [hasUnsavedChanges, pending, onDirty])
  useEffect(() => {
    if (!hasUnsavedChanges) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [hasUnsavedChanges])
  function changed(patch: Partial<Pick<Issue, 'title' | 'content' | 'status' | 'priority'>>) {
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
          if (!snapshot.title.trim()) { setError(saveMessages.current.t('titleRequired')); return false }
          const yjs = sync?.getSnapshot() ?? readOnlySnapshot()
          const bodyDirty = JSON.stringify(snapshot.content) !== JSON.stringify(savedRef.current.content)
          if (sync && (yjs.pending || bodyDirty) && yjs.ready) await sync.flush(initial.id)
          else if (bodyDirty && !yjs.ready) { setError(saveMessages.current.t('documentNotConnected')); return false }
          if (snapshot.generation !== acknowledged.current) {
            const result = await saveIssue({ id: initial.id, revision: savedRef.current.revision, title: snapshot.title, content: snapshot.content, status: snapshot.status, priority: snapshot.priority })
            if (!('issue' in result) || !result.issue) { setError(saveMessages.current.actionError(result.error ?? 'issueSaveFailed')); return false }
            savedRef.current = result.issue
            setSaved(result.issue)
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
  }, [initial.id, sync, onSaved, refreshVersions])
  useEffect(() => {
    onRegisterFlush(save)
    return () => onRegisterFlush(null)
  }, [onRegisterFlush, save])
  useEffect(() => {
    if (!editSequence || !syncState.ready) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [editSequence, syncState.ready, save])
  function adopt(issue: Issue) {
    savedRef.current = issue; setSaved(issue); setStatus(issue.status); setPriority(issue.priority)
    draft.current = { ...draft.current, status: issue.status, priority: issue.priority }
    void refreshVersions().catch(() => {}); onSaved(issue.id)
  }
  async function getCurrent() { return await save() ? savedRef.current : null }
  async function restore(version: NonNullable<typeof versions>[number]) {
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
  const activity = historyError
    ? <Button variant="ghost" size="sm" type="button" onClick={() => { void refreshVersions() }}>{t('activityFailed')}</Button>
    : <IssueActivityFeed versions={versions ?? []} children={subtasks} />

  const properties = <IssueDetailProperties task={saved} onMetadataSaved={adopt} metadataDisabled={false} onMetadataBusy={setMetadataSaving} status={status} priority={priority} pending={false} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} request={propertyRequest} onDate={() => requestAction('dueDate')} onEstimate={() => requestAction('estimate')} relations={<IssueRelations viewerId={user.id} mode="sidebar" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={false} />} />
  const threadPanel = openThread
    ? <IssueThreadPanel key={`${openThread}:${threadTab}`} issueId={saved.id} runId={openThread} initialTab={threadTab} onOpenThread={showThread} onClose={() => showThread(null)} />
    : openAcceptance && <FactoryAcceptancePanel key={openAcceptance.id} task={openAcceptance} onOpenThread={showThread} onClose={() => setOpenAcceptance(null)} />

  // R-61: one line under the header, one before the properties or an open thread; the page scrolls, the right column stays.
  return <div className="flex min-w-0 flex-1">
    <div className="flex min-w-0 flex-1 flex-col">
    <IssueDetailHeader workspaceName={workspaceName} identifier={saved.identifier} title={title} saveLabel={readOnly ? '' : error ? t('saveFailed') : syncState.error ? t('syncFailed') : pending || metadataSaving ? t('saving') : t('autosaved')} saved={!error && !syncState.error && !pending && !metadataSaving} pending={false} navigation={navigation} onClose={onClose} actions={<IssueDetailActions task={saved} userId={user.id} disabled={false} documentTools={documentTools} request={actionRequest} getCurrent={getCurrent} onSaved={adopt} onOpen={onOpen} onDeleted={onDeleted} onHistory={() => { void save().then(success => { if (success) { void refreshVersions(); setHistory(true) } }) }} onMembers={() => setMembers(true)} onDocumentTools={() => setDocumentTools(value => !value)} onProperty={requestProperty} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} />} />
    <div className="mx-auto flex w-full min-w-0 max-w-170 flex-1 flex-col gap-6 px-5 py-6 sm:px-8 lg:py-10">
      {!wide && <SectionBoundary onClose={onClose}>{properties}</SectionBoundary>}
      <div className="min-w-0">
        <div className="flex w-full flex-col gap-8">
          {error && <div className="flex flex-wrap items-center gap-2"><FieldError>{error}</FieldError><Button variant="outline" size="sm" disabled={pending} onClick={() => { void save() }}>{t('retryAutosave')}</Button></div>}
          <div className="flex min-w-0 flex-col gap-7">
            <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">{t('titleLabel')}</FieldLabel><Textarea id="task-title" aria-label={t('titleLabel')} rows={1} placeholder={t('titleLabel')} value={title} onChange={event => changed({ title: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; setEditSequence(value => value + 1) }} onBlur={() => { if (title.trim() && title !== saved.title) void save() }} maxLength={200} className="field-sizing-content min-h-10 w-full resize-none rounded-sm border-none bg-transparent px-0 py-0 text-2xl font-semibold tracking-tight shadow-none md:text-2xl outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:bg-transparent" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} /></Field></FieldGroup>
            {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />{t('backToSimple')}</Button></div>}
    <SectionBoundary onClose={onClose}>{syncState.ready || readOnly ? <>{readOnly && <Alert><AlertDescription>{t('invalidContentReadOnly')}</AlertDescription></Alert>}<IssueEditor persisted content={content} disabled={readOnly} layout={documentTools ? 'document' : 'issue'} activity={activity} threadEvents={<ThreadEvents issueId={saved.id} onOpen={showThread} />} afterDescription={<><IssueRelations viewerId={user.id} mode="subissues" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={false} /><IssueThreads issueId={saved.id} openId={openThread} onOpen={showThread} /><FactoryAcceptance issueId={saved.id} onOpen={showAcceptance} /></>} sharedDoc={sync?.doc} author={user.name || user.email} authorId={user.id} replacement={replacement} onReplacementApplied={replacementApplied} syncLabel={readOnly ? '' : syncState.error ? t('syncFailedLabel') : t('syncedLabel')} onChange={descriptionChanged} /></> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>{t('retrySync')}</Button>}</div>}</SectionBoundary>
          </div>
          {syncState.error && <FieldError className="text-xs">{t('syncRetryNotice')}</FieldError>}
        </div>
      </div>
    </div>
    </div>
    {/* One element for both widths: crossing the breakpoint restyles the open thread instead of remounting it (its tab, viewer and draft stay). */}
    {(wide || threadPanel) && <div className={cn(wide ? 'sticky top-0 flex h-[calc(100svh-3.25rem)] shrink-0 flex-col self-start border-l border-rule' : 'fixed inset-0 z-30 flex flex-col bg-background')}>
      {threadPanel ? <div className={cn('flex h-full flex-col', wide && 'w-108')}>{threadPanel}</div> : <div className="w-80 overflow-y-auto px-6 py-10"><SectionBoundary onClose={onClose}>{properties}</SectionBoundary></div>}
    </div>}
    <Dialog open={members} onOpenChange={setMembers}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t('membersTitle')}</DialogTitle><DialogDescription>{tDetail('membersDialogDescription')}</DialogDescription></DialogHeader><IssueMembers id={saved.id} onChanged={async () => { adopt(await loadIssue(saved.id)) }} /></DialogContent></Dialog>
    <IssueDescriptionHistory open={history} onOpenChange={setHistory} identifier={saved.identifier} title={title} currentContent={content} versions={versions} loadingError={!!historyError} onRetry={() => { void refreshVersions() }} onRestore={restore} />
  </div>
}
