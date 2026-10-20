'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import type { JSONContent } from '@tiptap/react'
import { Check, History, Loader2, Save, X } from 'lucide-react'
import { getIssue, saveIssue, listIssueVersions } from '@/app/actions/issues'
import { IssueEditor } from './issue-editor'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

type Issue = Awaited<ReturnType<typeof getIssue>>
export function TaskDetail({ id, onSaved, onDirty }: { id: string | null; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void }) {
  const { data, error, isLoading } = useSWR(id ? ['issue', id] : null, () => getIssue(id!), { revalidateOnFocus: false })
  if (id && (isLoading || !data) && !error) return <p role="status" className="p-8 text-sm text-muted-foreground">正在读取任务…</p>
  if (error) return <p role="alert" className="p-8 text-sm text-destructive">任务读取失败，请重新选择任务或刷新后重试。</p>
  return <TaskForm key={id ?? 'new'} initial={data} onSaved={onSaved} onDirty={onDirty} />
}
const EMPTY: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }
function TaskForm({ initial, onSaved, onDirty }: { initial?: Issue; onSaved: (id: string) => void; onDirty: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState(initial)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [content, setContent] = useState<JSONContent>(initial?.content ?? EMPTY)
  const [status, setStatus] = useState(initial?.status ?? 'todo')
  const [priority, setPriority] = useState(initial?.priority ?? 'normal')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const { data: versions, error: historyError, mutate: refreshVersions } = useSWR(history && saved ? ['versions', saved.id] : null, () => listIssueVersions(saved!.id))
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  function changed() { setDirty(true); setError('') }
  async function save() {
    if (pending || !title.trim()) return
    setPending(true); setError('')
    try {
      const result = await saveIssue({ id: saved?.id, revision: saved?.revision, title, content, status, priority })
      if (!('issue' in result) || !result.issue) { setError(result.error ?? '保存未成功。'); return }
      setSaved(result.issue); setDirty(false); onDirty(false)
      void refreshVersions()
      onSaved(result.issue.id)
    } catch { setError('暂时无法保存，请保留草稿并稍后重试。') }
    finally { setPending(false) }
  }
  function restore(version: NonNullable<typeof versions>[number]) {
    if (dirty && !window.confirm('替换当前未保存的草稿？')) return
    setTitle(version.title); setContent(version.content); setStatus(version.status); setPriority(version.priority)
    setEditorKey(value => value + 1); changed(); setHistory(false)
  }
  return <div className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{saved ? '任务文档' : '新建任务'}</span><Badge variant="outline">{dirty ? '有未保存修改' : saved ? `已保存 · v${saved.revision}` : '未保存草稿'}</Badge></div><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={!saved || pending} onClick={() => setHistory(!history)}><History data-icon="inline-start" />版本历史</Button><Button size="sm" disabled={pending || !title.trim() || (!!saved && !dirty)} onClick={save}>{pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}{pending ? '正在保存' : saved ? '保存修改' : '创建任务'}</Button></div></div>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    <div inert={pending} className="flex flex-col gap-6"><FieldGroup><Field><FieldLabel htmlFor="task-title" className="sr-only">任务标题</FieldLabel><Input id="task-title" placeholder="需要完成什么？" value={title} onChange={event => { setTitle(event.target.value); changed() }} maxLength={200} className="h-12" /></Field><div className="flex flex-wrap gap-2"><NativeSelect aria-label="任务状态" size="sm" value={status} onChange={event => { setStatus(event.target.value); changed() }}><NativeSelectOption value="todo">待处理</NativeSelectOption><NativeSelectOption value="doing">进行中</NativeSelectOption><NativeSelectOption value="review">待审阅</NativeSelectOption><NativeSelectOption value="done">已完成</NativeSelectOption></NativeSelect><NativeSelect aria-label="任务优先级" size="sm" value={priority} onChange={event => { setPriority(event.target.value); changed() }}><NativeSelectOption value="urgent">紧急优先级</NativeSelectOption><NativeSelectOption value="high">高优先级</NativeSelectOption><NativeSelectOption value="normal">普通优先级</NativeSelectOption><NativeSelectOption value="low">低优先级</NativeSelectOption></NativeSelect><Badge variant="outline">仅本人可访问</Badge></div></FieldGroup>
    <IssueEditor key={editorKey} content={content} onChange={value => { setContent(value); changed() }} />
    </div>
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs leading-6 text-muted-foreground">{saved && !dirty ? <><Check className="size-3.5" />正文已保存到 Neon · v{saved.revision} · 刷新后可重新打开</> : '修改后请点击保存。选区评论仍是会话草稿，不会随任务持久化。'}</p>
    {history && <section aria-label="版本历史" className="flex flex-col gap-4 rounded-lg border p-4"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">版本历史</h2><Button size="icon-sm" variant="ghost" aria-label="关闭版本历史" onClick={() => setHistory(false)}><X /></Button></div><p className="text-xs leading-6 text-muted-foreground">每次保存保留快照。载入旧版本只替换草稿，再次保存才会生成新版本，不覆盖历史。</p>{historyError ? <p role="alert" className="text-xs text-destructive">版本读取失败，请稍后重试。</p> : !versions ? <p role="status" className="text-xs">正在读取历史…</p> : versions.map(version => <article key={version.id} className="flex flex-col gap-3 border-t pt-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium">v{version.revision} · {version.title}</p><time className="text-[11px] text-muted-foreground">{new Date(version.createdAt).toLocaleString('zh-CN')}</time></div><Button size="sm" variant="outline" onClick={() => restore(version)}>载入此版本</Button></div><p className="line-clamp-3 text-xs leading-6 text-muted-foreground">{plainText(version.content) || '空白文档'}</p></article>)}</section>}
  </div>
}
function plainText(node: JSONContent): string {
  return [node.text ?? '', ...(node.content ?? []).map(plainText)].filter(Boolean).join(' ')
}
