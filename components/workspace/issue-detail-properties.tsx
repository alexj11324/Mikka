'use client'

import { ChartNoAxesColumnIncreasing, CircleDashed, History, Users } from 'lucide-react'
import { IssueTeamControl } from '@/components/teams/issue-team-control'
import { Button } from '@/components/ui/button'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'

export function IssueDetailProperties({ issueId, status, priority, revision, createdAt, updatedAt, pending, onStatus, onPriority, onMembers, onHistory }: {
  issueId: string; status: string; priority: string; revision: number; createdAt: Date | string; updatedAt: Date | string; pending: boolean
  onStatus: (value: string) => void; onPriority: (value: string) => void; onMembers: () => void; onHistory: () => void
}) {
  return <aside aria-label="任务属性" className="flex w-full shrink-0 flex-col gap-6 px-5 py-6 lg:w-64 xl:w-72">
    <div className="flex flex-col items-start gap-3"><h2 className="px-2 text-xs font-medium text-muted-foreground">属性</h2>
      <IssuePropertyMenu label="任务状态" value={status} options={ISSUE_STATUSES} icon={CircleDashed} disabled={pending} onChange={onStatus} />
      <IssuePropertyMenu label="任务优先级" value={priority} options={ISSUE_PRIORITIES} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={onPriority} />
      <Button variant="ghost" size="sm" onClick={onMembers}><Users data-icon="inline-start" />协作成员</Button>
    </div>
    <IssueTeamControl issueId={issueId} disabled={pending} />
    <div className="flex flex-col items-start gap-3"><Button size="sm" variant="ghost" onClick={onHistory}><History data-icon="inline-start" />版本历史<span className="text-muted-foreground">v{revision}</span></Button><dl className="flex flex-col gap-3 px-2 text-xs text-muted-foreground"><div className="flex flex-wrap gap-2"><dt>创建于</dt><dd><time dateTime={new Date(createdAt).toISOString()}>{new Date(createdAt).toLocaleDateString('zh-CN')}</time></dd></div><div className="flex flex-wrap gap-2"><dt>更新于</dt><dd><time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleDateString('zh-CN')}</time></dd></div></dl></div>
  </aside>
}
