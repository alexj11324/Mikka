'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { moveIssueToProject } from '@/app/actions/projects'
import useSWR from 'swr'
import { Box, Check, Circle, GitMerge, GitPullRequest, Link2, Tag, X } from 'lucide-react'
import { getIssuePropertyOptions, updateIssueMetadata, type IssueMetadataPatch } from '@/app/actions/issue-metadata'
import { LABEL_COLORS, type IssueLabel, type IssueMetadata, type IssuePullRequest } from '@/lib/issue-metadata'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { IssueAssigneeMenu } from './issue-assignee-menu'
import { IssuePropertyMenu } from './issue-property-menu'
import { cn } from '@/lib/utils'

export type MetadataSavedIssue = NonNullable<Awaited<ReturnType<typeof updateIssueMetadata>>['issue']>
type Target = 'project' | 'labels' | 'pullRequests' | 'invite'
export type MetadataRequest = { target: Target | 'assignee'; sequence: number }
const TITLES = { project: '设置所属项目', labels: '编辑任务标签', pullRequests: '管理关联 PR', invite: '邀请并分配成员' }
const COLOR_NAMES = { violet: '紫色', blue: '蓝色', green: '绿色', yellow: '黄色', red: '红色', gray: '灰色' }
const PR_STATES = [{ value: 'open', label: '进行中', icon: GitPullRequest }, { value: 'merged', label: '已合并', icon: GitMerge }, { value: 'closed', label: '已关闭', icon: X }]

export function LabelDot({ color }: { color: IssueLabel['color'] }) {
  return <Circle data-icon="inline-start" className={cn('fill-current', { 'text-label-violet': color === 'violet', 'text-label-blue': color === 'blue', 'text-success-foreground': color === 'green', 'text-warning-foreground': color === 'yellow', 'text-destructive': color === 'red', 'text-muted-foreground': color === 'gray' })} />
}

export function IssueMetadataControls({ task, section = 'all', compact = false, disabled = false, onSaved, onBusyChange, request }: {
  task: { id: string; revision: number; metadata: IssueMetadata }
  section?: 'all' | 'assignee' | 'properties' | 'project' | 'labels' | 'pullRequests'
  request?: MetadataRequest | null
  compact?: boolean; disabled?: boolean
  onSaved: (issue: MetadataSavedIssue) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [color, setColor] = useState<IssueLabel['color']>('violet')
  const [labels, setLabels] = useState<IssueLabel[]>([])
  const [prs, setPrs] = useState<IssuePullRequest[]>([])
  const [prState, setPrState] = useState<IssuePullRequest['state']>('open')
  const fieldId = useId()
  const { data: options } = useSWR(target === 'project' || target === 'labels' ? ['issue-property-options', task.id] : null, () => getIssuePropertyOptions(task.id))
  const busy = disabled || pending
  useEffect(() => {
    if (!request || request.target === 'assignee') return
    const matches = section === 'all' || section === request.target || (section === 'assignee' && request.target === 'invite')
    if (matches) {
      setError(''); setTarget(request.target); setName(request.target === 'project' ? task.metadata.project ?? '' : '')
      setLabels(task.metadata.labels); setPrs(task.metadata.pullRequests); setPrState('open')
    }
  }, [request, section])

  function open(value: Target) {
    setError(''); setTarget(value); setName(value === 'project' ? task.metadata.project ?? '' : '')
    setLabels(task.metadata.labels); setPrs(task.metadata.pullRequests); setPrState('open')
  }
  async function persist(patch: IssueMetadataPatch, inviteEmail?: string) {
    if (saving.current || disabled) return false
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const result = await updateIssueMetadata({ id: task.id, revision: task.revision, patch, inviteEmail })
      if (!result.issue) { setError(result.error ?? '保存失败，请重试。'); return false }
      onSaved(result.issue)
      return true
    } catch { setError('保存失败，请稍后重试。'); return false }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    let patch: IssueMetadataPatch = {}
    if (target === 'project') { await project(name.trim() || null); return }
    if (target === 'labels') {
      const next = name.trim() ? [...labels.filter(label => label.name.toLowerCase() !== name.trim().toLowerCase()), { name: name.trim(), color }] : labels
      patch = { labels: next }
    }
    if (target === 'pullRequests') patch = { pullRequests: name.trim() ? [...prs.filter(pr => pr.url !== name.trim()), { url: name.trim(), state: prState }] : prs }
    if (await persist(patch, target === 'invite' ? name.trim().toLowerCase() : undefined)) setTarget(null)
  }
  async function project(value: string | null) {
    if (saving.current || disabled) return
    const selected = options?.projectRecords.find(item => item.name === value)
    if (value && !selected) { setError('请选择一个现有项目。新项目请先在项目页面创建。'); return }
    saving.current = true; setPending(true); setError(''); onBusyChange?.(true)
    try {
      const result = await moveIssueToProject({ issueId: task.id, revision: task.revision, projectId: selected?.id ?? null })
      if (!result.issue) { setError(result.error ?? '项目关联失败。'); return }
      onSaved(result.issue); setTarget(null)
    } catch { setError('项目关联失败，请重试。') }
    finally { saving.current = false; setPending(false); onBusyChange?.(false) }
  }
  const metadata = task.metadata
  return <>
    {(section === 'all' || section === 'assignee') && <IssueAssigneeMenu request={request} id={task.id} assignee={metadata.assignee} compact={compact} disabled={busy} onChange={assignee => persist({ assignee })} onInvite={() => open('invite')} />}
    {section !== 'assignee' && <>
      {(section === 'all' || section === 'properties' || section === 'project') && <Button variant={section === 'project' ? 'ghost' : 'outline'} size={section === 'project' ? 'sm' : 'xs'} type="button" className={cn('max-w-full justify-start', section !== 'project' && 'rounded-full')} disabled={busy} onClick={() => open('project')} title={metadata.project ?? '设置所属项目'} aria-label={`所属项目：${metadata.project ?? '未设置'}`}><Box data-icon="inline-start" /><span className="truncate">{metadata.project ?? '添加到项目'}</span></Button>}
      {(section === 'all' || section === 'properties' || section === 'labels') && <>
      {metadata.labels.map(label => <Button key={label.name} variant="outline" size="xs" type="button" className="max-w-full rounded-full" disabled={busy} onClick={() => open('labels')} aria-label={`编辑标签：${label.name}`}><LabelDot color={label.color} /><span className="truncate">{label.name}</span></Button>)}
      {!metadata.labels.length && <Button variant="outline" size="xs" type="button" className="rounded-full" disabled={busy} onClick={() => open('labels')}><Tag data-icon="inline-start" />标签</Button>}
      </>}
      {(section === 'all' || section === 'properties' || section === 'pullRequests') && <>
      {metadata.pullRequests.map(pr => {
        const Icon = pr.state === 'merged' ? GitMerge : pr.state === 'closed' ? X : GitPullRequest
        return <Badge key={pr.url} variant="outline" className="h-6" render={<a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" title={`${PR_STATES.find(state => state.value === pr.state)?.label} · ${pr.url}`} aria-label={`打开关联 PR #${pr.url.split('/').at(-1)}（${PR_STATES.find(state => state.value === pr.state)?.label}）`} />}><Icon data-icon="inline-start" className={cn({ 'text-success-foreground': pr.state === 'open', 'text-info-foreground': pr.state === 'merged', 'text-destructive': pr.state === 'closed' })} />#{pr.url.split('/').at(-1)}</Badge>
      })}
      <Button variant={metadata.pullRequests.length ? 'ghost' : 'outline'} size={metadata.pullRequests.length ? 'icon-xs' : 'xs'} type="button" className="rounded-full" disabled={busy} onClick={() => open('pullRequests')} aria-label="管理关联 PR"><Link2 data-icon="inline-start" />{!metadata.pullRequests.length && '关联 PR'}</Button>
      </>}
    </>}
    {error && !target && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    <Dialog open={target !== null} onOpenChange={value => { if (!value && !pending) { setTarget(null); setError('') } }}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{target ? TITLES[target] : '任务属性'}</DialogTitle><DialogDescription>{target === 'invite' ? '使用已注册邮箱添加协作成员，并将此任务分配给对方。' : target === 'pullRequests' ? '关联真实 GitHub PR；状态由你维护，不会自动同步 GitHub。' : '修改会保存到当前任务，并同步到看板与详情。'}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {target === 'project' && <Command shouldFilter={false}><CommandInput placeholder="搜索或输入项目名称…" aria-label="项目名称" value={name} onValueChange={setName} maxLength={100} /><CommandList><CommandEmpty>未找到项目，请先在项目页面创建</CommandEmpty><CommandGroup heading="所属项目"><CommandItem disabled={busy} onSelect={() => { void project(null) }}><Box /><span className="flex-1">无项目</span>{!metadata.project && <Check />}</CommandItem>{(options?.projects ?? []).filter(item => item.toLowerCase().includes(name.toLowerCase())).map(item => <CommandItem key={item} disabled={busy} onSelect={() => { void project(item) }}><Box /><span className="flex-1 truncate">{item}</span>{metadata.project === item && <Check />}</CommandItem>)}</CommandGroup></CommandList></Command>}
          {target === 'labels' && <>
            <FieldGroup>{[...new Map([...(options?.labels ?? []), ...labels].map(label => [label.name, label])).values()].map(label => <Field key={label.name} orientation="horizontal"><Checkbox id={`${fieldId}-${label.name}`} disabled={busy} checked={labels.some(item => item.name === label.name)} onCheckedChange={checked => setLabels(current => checked ? [...current.filter(item => item.name !== label.name), label] : current.filter(item => item.name !== label.name))} /><FieldLabel htmlFor={`${fieldId}-${label.name}`}><LabelDot color={label.color} />{label.name}</FieldLabel></Field>)}</FieldGroup>
            <FieldGroup><Field><FieldLabel htmlFor={fieldId}>新标签名称</FieldLabel><Input id={fieldId} value={name} onChange={event => setName(event.target.value)} placeholder="例如：Feature" maxLength={40} disabled={busy} /></Field><Field><FieldLabel>标签颜色</FieldLabel><IssuePropertyMenu label="标签颜色" value={color} options={LABEL_COLORS.map(value => ({ value, label: COLOR_NAMES[value] }))} icon={Tag} disabled={busy} onChange={value => setColor(value as IssueLabel['color'])} /></Field></FieldGroup>
          </>}
          {target === 'pullRequests' && <>
            <div className="flex flex-col gap-3">{prs.map(pr => <div key={pr.url} className="flex min-w-0 items-center gap-2"><a href={pr.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-sm underline">{pr.url.replace('https://github.com/', '')}</a><IssuePropertyMenu label={`PR #${pr.url.split('/').at(-1)} 状态`} value={pr.state} options={PR_STATES} icon={GitPullRequest} compact disabled={busy} onChange={value => setPrs(current => current.map(item => item.url === pr.url ? { ...item, state: value as IssuePullRequest['state'] } : item))} /><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={`移除 PR #${pr.url.split('/').at(-1)}`} onClick={() => setPrs(current => current.filter(item => item.url !== pr.url))}><X data-icon="inline-start" /></Button></div>)}</div>
            <FieldGroup><Field><FieldLabel htmlFor={fieldId}>添加 GitHub PR 链接</FieldLabel><Input id={fieldId} type="url" value={name} onChange={event => setName(event.target.value)} placeholder="https://github.com/owner/repo/pull/81" maxLength={500} disabled={busy} /></Field><Field><FieldLabel>新增 PR 状态</FieldLabel><IssuePropertyMenu label="新增 PR 状态" value={prState} options={PR_STATES} icon={GitPullRequest} disabled={busy} onChange={value => setPrState(value as IssuePullRequest['state'])} /></Field></FieldGroup>
          </>}
          {target === 'invite' && <FieldGroup><Field><FieldLabel htmlFor={fieldId}>成员邮箱</FieldLabel><Input id={fieldId} type="email" value={name} onChange={event => setName(event.target.value)} placeholder="输入对方已注册的邮箱" required maxLength={254} disabled={busy} /></Field></FieldGroup>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="ghost" disabled={pending} onClick={() => setTarget(null)}>取消</Button><Button type="submit" disabled={busy}>{pending ? '正在保存…' : target === 'invite' ? '邀请并分配' : '保存'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
