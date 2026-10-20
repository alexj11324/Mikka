'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import useSWR from 'swr'
import type { JSONContent } from '@tiptap/react'
import { ArrowLeft, Check, FileText, History, Loader2, MoreHorizontal, Users, X } from 'lucide-react'
import { getIssue, saveIssue, listIssueVersions } from '@/app/actions/issues'
import { IssueEditor, createDocumentSeed } from './issue-editor'
import { DocumentSync } from '@/lib/document-sync'
import { IssueMembers } from './issue-members'
import { IssueDetailProperties } from './issue-detail-properties'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'

type Issue = Awaited<ReturnType<typeof getIssue>>
type WorkspaceUser = { id: string; name: string; email: string }
type DetailProps = { user: WorkspaceUser; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void }

export function TaskDetail({ id, ...props }: DetailProps & { id: string }) {
  const { data, error, mutate } = useSWR(['issue', id], () => getIssue(id), { revalidateOnFocus: false })
  if (error) return <div className="flex flex-col items-start gap-3 p-8"><p role="alert" className="text-sm text-destructive">任务读取失败，请重试。</p><Button size="sm" variant="outline" onClick={() => { void mutate() }}>重新读取</Button></div>
  if (!data) return <div role="status" aria-label="正在读取任务" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
  return <TaskForm key={id} initial={data} {...props} />
}

function TaskForm({ initial, user, onSaved, onDirty, onClose }: DetailProps & { initial: Issue }) {
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
  const saving = useRef(false)
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
  function changed() { setDirty(true); setError('') }
  async function save(patch: Partial<Pick<Issue, 'title' | 'status' | 'priority'>> = {}) {
    const nextTitle = patch.title ?? title
    if (saving.current || !nextTitle.trim() || !syncState.ready) return
    saving.current = true
    setPending(true)
    setError('')
    try {
      await sync.flush(saved.id)
      const result = await saveIssue({ id: saved.id, revision: saved.revision, title: nextTitle, content, status: patch.status ?? status, priority: patch.priority ?? priority })
      if (!('issue' in result) || !result.issue) { setError(result.error ?? '保存未成功。'); return }
      setSaved(result.issue)
      await sync.flush(result.issue.id)
      setDirty(false)
      void refreshVersions()
      onSaved(result.issue.id)
    } catch { setError('暂时无法保存，修改已保留，请重试。') }
    finally { saving.current = false; setPending(false) }
  }
  function restore(version: NonNullable<typeof versions>[number]) {
    if (!window.confirm('载入旧版本会立即作为正文修改同步给所有成员，保留现有评论；再次保存会创建新版本。是否继续？')) return
    setTitle(version.title); setContent(version.content); setStatus(version.status); setPriority(version.priority)
    setReplacement(value => ({ content: version.content, version: (value?.version ?? 0) + 1 }))
    changed(); setHistory(false)
  }
  const activity = <div className="flex flex-col gap-4 text-xs text-muted-foreground">
    {historyError ? <button type="button" onClick={() => { void refreshVersions() }} className="text-left">活动读取失败，点击重试</button> : (versions ?? []).slice(0, 3).reverse().map(version => <div key={version.id} className="flex items-start gap-3"><History className="mt-0.5 size-3.5 shrink-0" /><div className="flex flex-wrap items-center gap-2"><span>{version.revision === 1 ? '创建了任务' : `保存了版本 v${version.revision}`}</span><span>{ISSUE_STATUSES.find(item => item.value === version.status)?.label}</span><time dateTime={new Date(version.createdAt).toISOString()}>{new Date(version.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div></div>)}
  </div>

  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="返回任务视图" disabled={pending} onClick={onClose}><ArrowLeft /></Button><span className="truncate font-mono text-xs text-muted-foreground">{issueIdentifier(saved.id)}</span></div>
      <div className="flex items-center gap-2"><span role="status" aria-live="polite" className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">{pending ? '正在保存…' : syncState.error ? '同步失败' : syncState.pending || syncState.syncing ? '正在同步…' : dirty ? '有未保存修改' : <><Check className="size-3.5" />已保存</>}</span>
        {dirty && <Button size="sm" disabled={pending || !syncState.ready || !title.trim()} onClick={() => { void save() }}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}保存修改</Button>}
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多任务操作" disabled={pending} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-44"><DropdownMenuGroup><DropdownMenuItem onClick={() => setDocumentTools(value => !value)}><FileText />{documentTools ? '返回任务描述' : '高级文档工具'}</DropdownMenuItem><DropdownMenuItem onClick={() => setHistory(true)}><History />版本历史</DropdownMenuItem><DropdownMenuItem onClick={() => setMembers(true)}><Users />管理协作成员</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" disabled={pending} onClick={onClose}><X /></Button>
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <div className="min-w-0 flex-1 px-6 py-8 sm:px-10 sm:py-12 xl:px-16">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div inert={pending} className="flex min-w-0 flex-col gap-5">
            <FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">任务标题</FieldLabel><textarea id="task-title" rows={1} placeholder="任务标题" value={title} onChange={event => { setTitle(event.target.value); changed() }} onBlur={() => { if (title.trim() && title !== saved.title) void save({ title }) }} maxLength={200} className="field-sizing-content min-h-10 w-full resize-none rounded-sm bg-transparent text-2xl leading-snug font-semibold tracking-tight outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} /></Field></FieldGroup>
            {documentTools && <div><Button size="sm" variant="ghost" onClick={() => setDocumentTools(false)}><ArrowLeft data-icon="inline-start" />返回简洁描述</Button></div>}
            {syncState.ready ? <IssueEditor persisted content={content} layout={documentTools ? 'document' : 'issue'} activity={activity} sharedDoc={sync.doc} author={user.name || user.email} replacement={replacement} syncLabel={syncState.error ? '同步失败' : syncState.pending || syncState.syncing ? '正在同步' : '已同步'} onChange={value => { setContent(value); changed() }} /> : <div className="flex flex-col items-start gap-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" />{syncState.error && <Button variant="outline" size="sm" onClick={() => { void retrySync().catch(() => {}) }}>重试文档同步</Button>}</div>}
          </div>
          {syncState.error && <p role="alert" className="text-xs text-destructive">同步失败，正在重试。请保留本页，避免丢失尚未同步的修改。</p>}
        </div>
      </div>
      <IssueDetailProperties status={status} priority={priority} revision={saved.revision} createdAt={saved.createdAt} updatedAt={saved.updatedAt} pending={pending || !syncState.ready} onStatus={value => { setStatus(value); changed(); void save({ status: value }) }} onPriority={value => { setPriority(value); changed(); void save({ priority: value }) }} onMembers={() => setMembers(true)} onHistory={() => setHistory(true)} />
    </div>
    <Dialog open={members} onOpenChange={setMembers}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>协作成员</DialogTitle><DialogDescription>管理此任务的访问与编辑权限。</DialogDescription></DialogHeader><IssueMembers id={saved.id} /></DialogContent></Dialog>
    <Dialog open={history} onOpenChange={setHistory}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>版本历史</DialogTitle><DialogDescription>载入旧版本会同步替换共享正文，评论保留；再次保存创建新版本。</DialogDescription></DialogHeader><div className="flex flex-col gap-4">{historyError ? <p role="alert" className="text-xs text-destructive">版本读取失败，请重试。</p> : !versions ? <Skeleton className="h-20 w-full" /> : versions.map(version => <article key={version.id} className="flex flex-col gap-3"><Separator /><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">v{version.revision} · {version.title}</p><time className="text-xs text-muted-foreground">{new Date(version.createdAt).toLocaleString('zh-CN')}</time></div><Button size="sm" variant="outline" disabled={pending} onClick={() => restore(version)}>载入此版本</Button></div><p className="line-clamp-3 text-xs leading-6 text-muted-foreground">{plainText(version.content) || '空白文档'}</p></article>)}</div></DialogContent></Dialog>
  </div>
}

function plainText(node: JSONContent): string {
  return [node.text ?? '', ...(node.content ?? []).map(plainText)].filter(Boolean).join(' ')
}
