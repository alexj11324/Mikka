'use client'

import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/react'
import { ChartNoAxesColumnIncreasing, ChevronRight, CircleDashed, LockKeyhole, Maximize2, Minimize2, SquareUserRound, X } from 'lucide-react'
import { saveIssue } from '@/app/actions/issues'
import useSWR from 'swr'
import { toast } from 'sonner'
import { listTeams } from '@/app/actions/teams'
import { setIssueTeam } from '@/app/actions/team-relations'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { IssueEditor } from './issue-editor'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'

const EMPTY: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function CreateIssueDialog({ open, onOpenChange, onCreated, author, initialTeamId = '', initialStatus = 'todo' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  author: string
  initialStatus?: string
  initialTeamId?: string
}) {
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const [teamId, setTeamId] = useState(initialTeamId)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState<JSONContent>(EMPTY)
  const [status, setStatus] = useState(initialStatus)
  const [priority, setPriority] = useState('normal')
  const [createMore, setCreateMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const [defaults, setDefaults] = useState({ status: initialStatus, priority: 'normal' })
  const dirty = !!title.trim() || JSON.stringify(content) !== JSON.stringify(EMPTY) || status !== defaults.status || priority !== defaults.priority || teamId !== initialTeamId
  const [expanded, setExpanded] = useState(false)

  useEffect(() => { if (notice && !pending) titleRef.current?.focus() }, [notice, pending])
  useEffect(() => {
    if (!open || !dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [open, dirty])

  function close() {
    if (submitting.current) return
    if (dirty && !window.confirm('放弃这份尚未创建的任务草稿？')) return
    onOpenChange(false)
  }

  async function create() {
    if (submitting.current || !title.trim()) return
    submitting.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await saveIssue({ title, content, status, priority })
      if (!('issue' in result) || !result.issue) {
        setError(result.error ?? '创建失败，草稿已保留。')
        return
      }
      if (teamId) {
        try {
          const relation = await setIssueTeam({ issueId: result.issue.id, teamId, expectedTeamId: null })
          if (!relation.ok) toast.warning(`任务已创建，团队归属未保存：${relation.error} 请在任务详情重试。`)
        } catch { toast.warning('任务已创建，但团队归属未保存。请在任务详情重试，不要重复创建。') }
      }
      onCreated(result.issue.id)
      if (createMore) {
        setDefaults({ status, priority })
        setTitle('')
        setContent(EMPTY)
        setEditorKey(value => value + 1)
        setNotice('任务已创建，可以继续添加下一项。')
        titleRef.current?.focus()
      } else {
        onOpenChange(false)
      }
    } catch {
      setError('暂时无法创建，草稿已保留，请稍后重试。')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
    <DialogContent showCloseButton={false} initialFocus={titleRef} className={cn('max-h-[calc(100svh-2rem)] gap-0 overflow-y-auto p-0 sm:top-[20svh] sm:max-h-[76svh] sm:max-w-3xl sm:translate-y-0', expanded && 'sm:max-w-5xl')}>
      <form onSubmit={event => { event.preventDefault(); void create() }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
        else if (event.key === 'Enter' && event.target === titleRef.current) event.preventDefault()
      }}>
        <header className="flex items-center justify-between gap-3 px-5 pt-4 sm:px-6">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline" className="gap-1.5 rounded-full"><SquareUserRound />ORV</Badge><ChevronRight className="size-3 text-muted-foreground" />
            <DialogTitle className="sr-only">新建任务</DialogTitle><span aria-hidden="true">新建任务</span>
          </div>
          <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="icon-sm" aria-label={expanded ? '收起创建卡片' : '展开创建卡片'} aria-pressed={expanded} disabled={pending} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label="关闭新建任务" disabled={pending} onClick={close}><X data-icon="inline-start" /></Button></div>
        </header>
        <DialogDescription className="sr-only">填写标题和描述，选择状态与优先级后创建任务。</DialogDescription>
        <FieldSet disabled={pending} className={cn('flex min-w-0 flex-col gap-5 px-5 pt-5 pb-5 sm:px-6', expanded && 'min-h-96')}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-issue-title" className="sr-only">任务标题</FieldLabel>
              <Input ref={titleRef} id="new-issue-title" autoComplete="off" maxLength={200} placeholder="任务标题" value={title} onChange={event => { setTitle(event.target.value); setError('') }} className="w-full border-none bg-transparent px-0 py-1 text-lg font-semibold shadow-none outline-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent" />
            </Field>
            <Field>
              <FieldLabel className="sr-only">任务描述</FieldLabel>
              <div inert={pending}><IssueEditor key={editorKey} compact content={content} author={author} onChange={setContent} /></div>
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-2">
            <IssuePropertyMenu pill label="任务状态" value={status} options={ISSUE_STATUSES} icon={CircleDashed} disabled={pending} onChange={setStatus} />
            <IssuePropertyMenu pill label="任务优先级" value={priority} options={ISSUE_PRIORITIES} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={setPriority} />
            <Badge variant="outline" className="h-7 gap-1.5 rounded-full px-2.5"><LockKeyhole />{teamId ? '工作区公开' : '私有'}</Badge>
          </div>
          <FieldGroup><Field><FieldLabel htmlFor="new-issue-team">归属团队</FieldLabel><NativeSelect id="new-issue-team" value={teamId} disabled={pending || !!teamsError} onChange={event => setTeamId(event.target.value)}><NativeSelectOption value="">无团队 · 私有任务</NativeSelectOption>{teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.identifier} · {team.name}</NativeSelectOption>)}</NativeSelect><p className="text-xs text-muted-foreground">{teamsError ? '团队读取失败，请稍后重试。' : teamId ? '此任务将对团队所在工作区所有启用成员公开并允许编辑。' : '仅你和后续授权的协作成员可以访问。'}</p></Field></FieldGroup>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </FieldSet>
        <footer className="flex flex-wrap items-center justify-between gap-3 px-5 pt-1 pb-4 sm:px-6">
          <span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter 创建</span>
          <div className="flex items-center gap-3">
            <FieldGroup className="contents"><Field orientation="horizontal"><Switch id="create-more" size="sm" checked={createMore} onCheckedChange={setCreateMore} disabled={pending} /><FieldLabel htmlFor="create-more">连续创建</FieldLabel></Field></FieldGroup>
            <Button type="submit" size="sm" disabled={pending || !title.trim()}>{pending && <Spinner data-icon="inline-start" />}{pending ? '正在创建…' : '创建任务'}</Button>
          </div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>
}
