'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { CalendarDays, CircleGauge, CircleCheck } from 'lucide-react'
import { listIssueVersions } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription, PopoverTrigger } from '@/components/ui/popover'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { IssueMembers } from './issue-members'
import type { BoardTask } from '@/components/blocks/kanban-board-1/components/data'
import type { IssueStatus } from './issue-properties'

export function CardControlBoundary({ children }: { children: ReactNode }) {
  return <div data-card-control className="contents" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{children}</div>
}

export function CardMembers({ task, disabled }: { task: BoardTask; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const owner = task.ownerName || '未知成员'
  return <CardControlBoundary><Dialog open={open} onOpenChange={setOpen}>
    <Button type="button" variant="ghost" size="xs" className="min-w-0 justify-start px-0" disabled={disabled} aria-label={`管理协作成员：${owner}`} onClick={() => setOpen(true)}>
      <Avatar size="sm">{task.ownerImage && <AvatarImage src={task.ownerImage} alt="" />}<AvatarFallback>{Array.from(owner).slice(0, 2).join('').toUpperCase()}</AvatarFallback></Avatar>
      <span className="max-w-20 truncate text-muted-foreground">{owner}</span>
    </Button>
    <DialogContent><DialogHeader><DialogTitle>协作成员</DialogTitle><DialogDescription>创建者：{owner}。管理此任务的协作访问权限。</DialogDescription></DialogHeader>{open && <IssueMembers id={task.id} defaultOpen />}</DialogContent>
  </Dialog></CardControlBoundary>
}

export function CardHistory({ task, disabled, onOpen }: { task: BoardTask; disabled: boolean; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const { data, error, mutate } = useSWR(open ? ['versions', task.id] : null, () => listIssueVersions(task.id))
  return <CardControlBoundary><Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="outline" size="xs" disabled={disabled} aria-label="查看任务更新记录" />}><CalendarDays data-icon="inline-start" /><time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time></PopoverTrigger>
    <PopoverContent align="end"><PopoverHeader><PopoverTitle>更新记录</PopoverTitle><PopoverDescription>卡片日期是最后更新时间，并非截止日期。</PopoverDescription></PopoverHeader>
      {error ? <Button type="button" variant="outline" size="sm" onClick={() => { void mutate() }}>重新读取更新记录</Button> : !data ? <Skeleton className="h-12 w-full" /> : <ol className="flex max-h-48 flex-col gap-3 overflow-y-auto text-xs">{data.map(version => <li key={version.id} className="flex flex-col gap-1"><span>v{version.revision} · {version.title}</span><time className="text-muted-foreground" dateTime={new Date(version.createdAt).toISOString()}>{new Date(version.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol>}
      <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); onOpen(task.id) }}>打开详情与完整版本操作</Button>
    </PopoverContent>
  </Popover></CardControlBoundary>
}

export function CardCompletion({ task, status, disabled, onOpen, onStatusChange }: { task: BoardTask; status: IssueStatus; disabled: boolean; onOpen: (id: string) => void; onStatusChange: (task: BoardTask, status: IssueStatus) => void }) {
  const [open, setOpen] = useState(false)
  const checklist = task.checklist
  const percentage = checklist.total ? checklist.percentage : status === 'done' ? 100 : 0
  const Icon = percentage === 100 ? CircleCheck : CircleGauge
  return <CardControlBoundary><Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={`查看完成度：${percentage}%`} />}><Icon data-icon="inline-start" /><span className="tabular-nums">{percentage}%</span></PopoverTrigger>
    <PopoverContent align="end"><PopoverHeader><PopoverTitle>任务完成度</PopoverTitle><PopoverDescription>{checklist.total ? `正文清单已完成 ${checklist.checked} / ${checklist.total} 项，随清单勾选自动更新。` : '尚未添加清单，当前按任务是否已完成显示。可在详情中插入并勾选任务清单。'}</PopoverDescription></PopoverHeader>
      <Progress value={percentage}><ProgressLabel>{checklist.total ? '清单完成度' : '任务完成状态'}</ProgressLabel><ProgressValue /></Progress>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { setOpen(false); onOpen(task.id) }}>打开详情编辑清单</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setOpen(false); onStatusChange(task, status === 'done' ? 'todo' : 'done') }}>{status === 'done' ? '重新打开任务' : '标记任务完成'}</Button>
    </PopoverContent>
  </Popover></CardControlBoundary>
}
