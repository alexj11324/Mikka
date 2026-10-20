'use client'

import { ChartNoAxesColumnIncreasing, CircleDashed, History, LockKeyhole, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'

export function IssueDetailProperties({ status, priority, revision, createdAt, updatedAt, pending, onStatus, onPriority, onMembers, onHistory }: {
  status: string; priority: string; revision: number; createdAt: Date | string; updatedAt: Date | string; pending: boolean
  onStatus: (value: string) => void; onPriority: (value: string) => void; onMembers: () => void; onHistory: () => void
}) {
  return <aside aria-label="任务属性" className="flex w-full shrink-0 flex-col gap-8 border-t px-4 py-6 sm:px-6 lg:sticky lg:top-20 lg:w-60 lg:self-start lg:border-t-0 lg:px-0 lg:py-0 xl:w-72">
    <div className="flex flex-col items-start gap-2"><h2 className="mb-1 px-2 text-sm font-medium text-muted-foreground">属性</h2>
      <IssuePropertyMenu label="任务状态" value={status} options={ISSUE_STATUSES} icon={CircleDashed} disabled={pending} onChange={onStatus} />
      <IssuePropertyMenu label="任务优先级" value={priority} options={ISSUE_PRIORITIES} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={onPriority} />
      <Button variant="ghost" size="sm" onClick={onMembers}><Users data-icon="inline-start" />协作成员</Button>
    </div>
    <div className="flex flex-col gap-4 px-2"><h2 className="text-xs font-medium text-muted-foreground">访问权限</h2><p className="flex items-center gap-2 text-xs"><LockKeyhole className="size-3.5 text-muted-foreground" />仅授权成员可访问</p></div>
    <div className="flex flex-col items-start gap-3"><Button size="sm" variant="ghost" onClick={onHistory}><History data-icon="inline-start" />版本历史<span className="text-muted-foreground">v{revision}</span></Button><dl className="flex flex-col gap-3 px-2 text-xs text-muted-foreground"><div className="flex flex-wrap gap-2"><dt>创建于</dt><dd><time dateTime={new Date(createdAt).toISOString()}>{new Date(createdAt).toLocaleDateString('zh-CN')}</time></dd></div><div className="flex flex-wrap gap-2"><dt>更新于</dt><dd><time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleDateString('zh-CN')}</time></dd></div></dl></div>
  </aside>
}
