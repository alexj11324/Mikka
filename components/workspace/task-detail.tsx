'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import type { JSONContent } from '@tiptap/react'
import { ArrowLeft, Check, FileText, History, MoreHorizontal, Users, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { getIssue, saveIssue, listIssueVersions } from '@/app/actions/issues'
import { useActionError } from '@/lib/use-action-error'
import { IssueEditor, createDocumentSeed } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { IssueMembers } from './issue-members'
import { IssueDetailProperties } from './issue-detail-properties'
import { issueIdentifier } from './issue-properties'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

type Issue = Awaited<ReturnType<typeof getIssue>>
type WorkspaceUser = { id: string; name: string; email: string }
type DetailProps = { user: WorkspaceUser; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void; onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void }

export function TaskDetail({ id, ...props }: DetailProps & { id: string }) {
  const t = useTranslations('Workspace.detail')
  const { data, error, mutate } = useSWR(['issue', id], () => getIssue(id), { revalidateOnFocus: false })
  if (error) return <div className="flex flex-col items-start gap-3 p-8"><p role="alert" className="text-sm text-destructive">{t('readFailed')}</p><Button size="sm" variant="outline" onClick={() => { void mutate() }}>{t('reload')}</Button></div>
  if (!data) return <div role="status" aria-label={t('reading')} className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
  return <TaskForm key={id} initial={data} {...props} />
}

function TaskForm({ initial, user, onSaved, onDirty, onClose, onRegisterFlush }: DetailProps & { initial: Issue }) {
  const t = useTranslations('Workspace.detail')
  const commonT = useTranslations('Common')
  const statusT = useTranslations('Issue.status')
  const format = useFormatter()
  const translateError = useActionError()
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
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
          if (!snapshot.title.trim()) { setError(t('titleRequired')); return false }
          if (!sync.getSnapshot().ready) { setError(t('documentNotConnected')); return false }
          await sync.flush(initial.id)
          if (snapshot.generation !== acknowledged.current) {
            const result = await saveIssue({ id: initial.id, revision: savedRef.current.revision, title: snapshot.title, content: snapshot.content, status: snapshot.status, priority: snapshot.priority })
            if ('error' in result) { setError(translateError(result.error)); return false }
            savedRef.current = result.issue
            setSaved(result.issue)
            acknowledged.current = snapshot.generation
            setDirty(draft.current.generation !== acknowledged.current)
            void refreshVersions().catch(() => {})
            onSaved(result.issue.id)
          }
        } while (draft.current.generation !== acknowledged.current)
        return true
      } catch (cause) { setError(cause instanceof Error && cause.message === 'documentPending' ? translateError('documentPending') : t('autosaveFailed')); return false }
      finally { setPending(false) }
    })()
    flight.current = operation
    void operation.finally(() => { flight.current = null })
    return operation
  }, [initial.id, sync, onSaved, refreshVersions, t])
  useEffect(() => {
    onRegisterFlush(save)
    return () => onRegisterFlush(null)
  }, [onRegisterFlush, save])
  useEffect(() => {
    if (!editSequence || !syncState.ready) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [editSequence, syncState.ready, save])
  function restore(version: NonNullable<typeof versions>[number]) {
    if (!window.confirm(t('restoreConfirm'))) return
    changed({ title: version.title, content: version.content, status: version.status, priority: version.priority })
    setReplacement(value => ({ content: version.content, version: (value?.version ?? 0) + 1 }))
    setHistory(false)
  }
  const activity = <div className="flex flex-col gap-4 text-xs text-muted-foreground">
    {historyError ? <Button variant="ghost" size="sm" type="button" onClick={() => { void refreshVersions() }}>{t('activityFailed')}</Button> : (versions ?? []).slice(0, 3).reverse().map(version => <div key={version.id} className="flex items-start gap-3"><History className="mt-0.5 size-3.5 shrink-0" /><div className="flex flex-wrap items-center gap-2"><span>{version.revision === 1 ? t('createdTask') : t('savedVersion', { revision: version.revision })}</span><span>{statusLabel(version.status)}</span><time dateTime={new Date(version.createdAt).toISOString()}>{format.dateTime(new Date(version.createdAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div></div>)}
  </div>

  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label={t('backToView')} disabled={pending} onClick={onClose}><ArrowLeft data-icon="inline-start" /></Button><span className="truncate font-mono text-xs text-muted-foreground">{issueIdentifier(saved.id)}</span></div>
      <div className="flex items-center gap-2"><span role="status" aria-live="polite" className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">{error ? t('saveFailed') : pending ? t('saving') : syncState.error ? t('syncFailed') : syncState.pending || syncState.syncing ? t('syncing') : dirty ? t('waitingAutosave') : <><Check className="size-3.5" />{t('autosaved')}</>}</span>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('moreActions')} disabled={pending} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-44"><DropdownMenuGroup><DropdownMenuItem onClick={() => setDocumentTools(value => !value)}><FileText />{documentTools ? t('backToSimple') : t('advancedTools')}</DropdownMenuItem><DropdownMenuItem onClick={() => setHistory(true)}><History />{t('history')}</DropdownMenuItem><DropdownMenuItem onClick={() => setMembers(true)}><Users />{t('manageMembers')}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label={t('closeDetail')} disabled={pending} onClick={onClose}><X data-icon="inline-start" /></Button>
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <div className="min-w-0 flex-1 px-6 py-8 sm:px-10 sm:py-12 xl:px-16">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" disabled={pending} onClick={() => { void save() }}>{t('retryAutosave')}</Button></div>}
          <div className="flex min-w-0 flex-col gap-5">
            <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">{t('titleLabel')}</FieldLabel><Textarea id="task-title" rows={1} placeholder={t('titleLabel')} value={title} onChange={event => changed({ title: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; setEditSequence(value => value + 1) }} onBlur={() => { if (title.trim() && title !== saved.title) void save() }} maxLength={200} className="field-sizing-content min-h-10 w-full resize-none rounded-sm border-none bg-transparent text-2xl leading-snug font-semibold tracking-tight shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:text-2xl dark:bg-transparent" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} /></Field></FieldGroup>
            {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />{t('backToSimple')}</Button></div>}
            {syncState.ready ? <IssueEditor persisted content={content} layout={documentTools ? 'document' : 'issue'} activity={activity} sharedDoc={sync.doc} author={user.name || user.email} replacement={replacement} syncLabel={syncState.error ? t('syncFailedLabel') : syncState.pending || syncState.syncing ? t('syncingLabel') : t('syncedLabel')} onChange={value => changed({ content: value })} /> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>{t('retrySync')}</Button>}</div>}
          </div>
          {syncState.error && <p role="alert" className="text-xs text-destructive">{t('syncRetryNotice')}</p>}
        </div>
      </div>
      <IssueDetailProperties status={status} priority={priority} revision={saved.revision} createdAt={saved.createdAt} updatedAt={saved.updatedAt} pending={pending || !syncState.ready} onStatus={value => { changed({ status: value }); void save() }} onPriority={value => { changed({ priority: value }); void save() }} onMembers={() => setMembers(true)} onHistory={() => setHistory(true)} />
    </div>
    <Dialog open={members} onOpenChange={setMembers}><DialogContent closeLabel={commonT('close')} className="max-h-[85svh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{t('membersTitle')}</DialogTitle><DialogDescription>{t('membersDescription')}</DialogDescription></DialogHeader><IssueMembers id={saved.id} /></DialogContent></Dialog>
    <Dialog open={history} onOpenChange={setHistory}><DialogContent closeLabel={commonT('close')} className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t('historyTitle')}</DialogTitle><DialogDescription>{t('historyDescription')}</DialogDescription></DialogHeader><div className="flex flex-col gap-4">{historyError ? <p role="alert" className="text-xs text-destructive">{t('historyReadFailed')}</p> : !versions ? <Skeleton className="h-20 w-full" /> : versions.map(version => <article key={version.id} className="flex flex-col gap-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">v{version.revision} · {version.title}</p><time className="text-xs text-muted-foreground">{format.dateTime(new Date(version.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</time></div><Button size="sm" variant="outline" disabled={pending} onClick={() => restore(version)}>{t('loadVersion')}</Button></div><p className="line-clamp-3 text-xs leading-6 text-muted-foreground">{plainText(version.content) || t('emptyDocument')}</p></article>)}</div></DialogContent></Dialog>
  </div>
}

function plainText(node: JSONContent): string {
  return [node.text ?? '', ...(node.content ?? []).map(plainText)].filter(Boolean).join(' ')
}
