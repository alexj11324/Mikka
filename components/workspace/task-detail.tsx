'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import type { JSONContent } from '@tiptap/react'
import { ArrowLeft, History } from 'lucide-react'
import { IssueDetailHeader, type IssueDetailNavigation } from './issue-detail-header'
import { IssueDetailActions, type IssueActionRequest } from './issue-detail-actions'
import { IssueDescriptionHistory } from './issue-description-history'
import { IssueRelations } from './issue-relations'
import type { MetadataRequest } from './issue-metadata-controls'
import { toast } from 'sonner'
import { getDeletedIssue, setIssueDeleted } from '@/app/actions/issue-operations'
import { getIssue, saveIssue, listIssueVersions } from '@/app/actions/issues'
import { IssueEditor, createDocumentSeed } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { useActionError } from '@/lib/use-action-error'
import { IssueMembers } from './issue-members'
import { IssueDetailProperties } from './issue-detail-properties'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

type Issue = Awaited<ReturnType<typeof getIssue>>
type WorkspaceUser = { id: string; name: string; email: string }
type DetailProps = { navigation: IssueDetailNavigation; onOpen: (id: string) => void; user: WorkspaceUser; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void; onDeleted: () => void; onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void }

function UnavailableIssue({ id, onRetry, onClose }: { id: string; onRetry: () => void; onClose: () => void }) {
  const t = useTranslations('IssueDetail')
  const actionError = useActionError()
  const { data } = useSWR(['deleted-issue', id], () => getDeletedIssue(id))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return <div className="flex flex-col items-start gap-4 p-8"><h1 className="text-lg font-semibold">{data ? t('deletedTitle') : t('unavailableTitle')}</h1><p role="status" className="text-sm text-muted-foreground">{data ? t('deletedDescription', { title: data.title }) : t('unavailableDescription')}</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex gap-2">{data && <Button disabled={pending} onClick={async () => { setPending(true); try { const result = await setIssueDeleted({ id, restore: true }); if (result.error) setError(actionError(result.error)); else { toast.success(t('taskRestored')); onRetry() } } catch { setError(t('restoreFailed')) } finally { setPending(false) } }}>{t('restoreTask')}</Button>}<Button size="sm" variant="outline" onClick={onRetry}>{t('reload')}</Button><Button size="sm" variant="ghost" onClick={onClose}>{t('backToWorkspace')}</Button></div></div>
}

export function TaskDetail({ id, ...props }: DetailProps & { id: string }) {
  const t = useTranslations('Workspace.detail')
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const { data, error, mutate } = useSWR(['issue', id], () => getIssue(id), { revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0, onSuccess: () => setLoadedId(id) })
  if (error) return <UnavailableIssue id={id} onRetry={() => { void mutate() }} onClose={props.onClose} />
  if (!data || loadedId !== id) return <div role="status" aria-label={t('reading')} className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
  return <TaskForm key={id} initial={data} {...props} />
}

function TaskForm({ initial, user, onSaved, onDirty, onClose, onDeleted, onRegisterFlush, navigation, onOpen }: DetailProps & { initial: Issue }) {
  const t = useTranslations('Workspace.detail')
  const tDetail = useTranslations('IssueDetail')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const actionError = useActionError()
  const saveMessages = useRef({ t, actionError })
  saveMessages.current = { t, actionError }
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [saved, setSaved] = useState(initial)
  const [sync] = useState(() => new DocumentSync(initial.id, createDocumentSeed(initial.content)))
  const syncState = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot)
  const { mutate: retrySync } = useSWR(['document-sync', saved.id, sync.doc.clientID], () => sync.exchange(saved.id), { refreshInterval: 1500, revalidateOnFocus: true, shouldRetryOnError: true, errorRetryInterval: 3000 })
  useEffect(() => {
    // Delay disposal so React Strict Mode's immediate effect replay retains this document.
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
  const [error, setError] = useState('')
  const [history, setHistory] = useState(false)
  const [members, setMembers] = useState(false)
  const [documentTools, setDocumentTools] = useState(false)
  const [propertyRequest, setPropertyRequest] = useState<MetadataRequest | null>(null)
  const [actionRequest, setActionRequest] = useState<IssueActionRequest | null>(null)
  const restoration = useRef<{ resolve: (success: boolean) => void } | null>(null)
  const [replacement, setReplacement] = useState<{ content: JSONContent; version: number }>()
  const { data: versions, error: historyError, mutate: refreshVersions } = useSWR(['versions', saved.id], () => listIssueVersions(saved.id), { revalidateOnFocus: false })
  const hasUnsavedChanges = dirty || syncState.pending
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
      setPending(true)
      setError('')
      try {
        do {
          const snapshot = { ...draft.current }
          if (!snapshot.title.trim()) { setError(saveMessages.current.t('titleRequired')); return false }
          if (!sync.getSnapshot().ready) { setError(saveMessages.current.t('documentNotConnected')); return false }
          await sync.flush(initial.id)
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
  const activity = <div className="flex flex-col gap-4 text-xs text-muted-foreground">
    {historyError ? <Button variant="ghost" size="sm" type="button" onClick={() => { void refreshVersions() }}>{t('activityFailed')}</Button> : (versions ?? []).slice(0, 3).reverse().map(version => <div key={version.id} className="flex items-start gap-3"><History className="mt-0.5 size-3.5 shrink-0" /><div className="flex flex-wrap items-center gap-2"><span>{version.revision === 1 ? t('createdTask') : t('savedVersion', { revision: version.revision })}</span><span>{statusLabel(version.status)}</span><time dateTime={new Date(version.createdAt).toISOString()}>{format.dateTime(new Date(version.createdAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div></div>)}
  </div>

  return <div className="flex min-w-0 flex-1 flex-col">
    <IssueDetailHeader number={saved.metadata.number} title={title} saveLabel={error ? t('saveFailed') : pending ? t('saving') : syncState.error ? t('syncFailed') : !syncState.ready ? tDetail('connecting') : syncState.pending || syncState.syncing ? t('syncing') : dirty ? t('waitingAutosave') : t('autosaved')} saved={syncState.ready && !error && !pending && !syncState.error && !syncState.pending && !syncState.syncing && !dirty} pending={pending} navigation={navigation} onClose={onClose} actions={<IssueDetailActions task={saved} userId={user.id} disabled={pending || !syncState.ready} documentTools={documentTools} request={actionRequest} getCurrent={getCurrent} onSaved={adopt} onOpen={onOpen} onDeleted={onDeleted} onHistory={() => { void save().then(success => { if (success) { void refreshVersions(); setHistory(true) } }) }} onMembers={() => setMembers(true)} onDocumentTools={() => setDocumentTools(value => !value)} onProperty={requestProperty} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} />} />
    <div className="mx-auto flex w-full min-w-0 max-w-screen-2xl flex-1 flex-col gap-2 lg:flex-row lg:gap-12 lg:px-10 lg:py-14 xl:gap-16 xl:px-16">
      <div className="min-w-0 flex-1 px-5 pt-8 pb-6 sm:px-10 sm:pt-12 lg:px-0 lg:py-0">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
          {error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" disabled={pending} onClick={() => { void save() }}>{t('retryAutosave')}</Button></div>}
          <div className="flex min-w-0 flex-col gap-7">
            <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">{t('titleLabel')}</FieldLabel><Textarea id="task-title" rows={1} placeholder={t('titleLabel')} value={title} onChange={event => changed({ title: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; setEditSequence(value => value + 1) }} onBlur={() => { if (title.trim() && title !== saved.title) void save() }} maxLength={200} className="field-sizing-content min-h-10 w-full resize-none rounded-sm border-none bg-transparent px-0 py-0 text-2xl leading-snug font-semibold tracking-tight shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:text-3xl dark:bg-transparent" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} /></Field></FieldGroup>
            {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />{t('backToSimple')}</Button></div>}
            {syncState.ready ? <IssueEditor persisted content={content} layout={documentTools ? 'document' : 'issue'} activity={activity} afterDescription={<IssueRelations mode="subissues" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={pending} />} sharedDoc={sync.doc} author={user.name || user.email} replacement={replacement} onReplacementApplied={replacementApplied} syncLabel={syncState.error ? t('syncFailedLabel') : syncState.pending || syncState.syncing ? t('syncingLabel') : t('syncedLabel')} onChange={descriptionChanged} /> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>{t('retrySync')}</Button>}</div>}
          </div>
          {syncState.error && <p role="alert" className="text-xs text-destructive">{t('syncRetryNotice')}</p>}
        </div>
      </div>
      <IssueDetailProperties task={saved} onMetadataSaved={adopt} metadataDisabled={pending || dirty || syncState.pending || !syncState.ready} onMetadataBusy={setPending} status={status} priority={priority} pending={pending || !syncState.ready} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} request={propertyRequest} onDate={() => requestAction('dueDate')} onEstimate={() => requestAction('estimate')} relations={<IssueRelations mode="sidebar" task={saved} onOpen={onOpen} onCreate={() => requestAction('createChild')} onPick={requestAction} getCurrent={getCurrent} onSaved={adopt} disabled={pending} />} />
    </div>
    <Dialog open={members} onOpenChange={setMembers}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t('membersTitle')}</DialogTitle><DialogDescription>{tDetail('membersDialogDescription')}</DialogDescription></DialogHeader><IssueMembers id={saved.id} onChanged={async () => { adopt(await getIssue(saved.id)) }} /></DialogContent></Dialog>
    <IssueDescriptionHistory open={history} onOpenChange={setHistory} number={saved.metadata.number} title={title} currentContent={content} versions={versions} loadingError={!!historyError} onRetry={() => { void refreshVersions() }} onRestore={restore} />
  </div>
}

