'use client'

import { Inbox, Send, Layers, Star, Bell } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { IssueList } from './issue-list'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from './issue-properties'
import type { WorkspaceSection } from './workspace-navigation'

export function WorkspaceOverview({ section, counts, projectCount, onView, onProjects, tasks, userId, onOpen }: { section: WorkspaceSection; counts: Record<IssueView, number>; projectCount: number; onView: (view: IssueView) => void; onProjects: () => void; tasks: Awaited<ReturnType<typeof listIssues>>; userId: string; onOpen: (id: string) => void }) {
  if (section === 'inbox') {
    const following = tasks.filter(task => task.metadata.subscriberUserIds.includes(userId))
    return <section aria-label="关注任务活动" className="flex flex-col gap-6 px-5 py-8"><header className="flex flex-col gap-2"><h1 className="text-lg font-semibold">关注的任务活动</h1><p className="text-sm text-muted-foreground">关注的任务会出现在这里，按最近更新时间排序。此处不会发送邮件或推送通知。</p></header>{following.length ? <IssueList issues={following} searching onOpen={onOpen} onCreate={() => onView('all')} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>尚未关注任务</EmptyTitle><EmptyDescription>在任务的更多操作中选择「关注任务活动」，即可在这里追踪更新。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => onView('all')}>查看全部任务</Button></Empty>}</section>
  }
  if (section === 'agent') return <Empty className="min-h-96"><EmptyHeader><EmptyMedia variant="icon"><Send /></EmptyMedia><EmptyTitle>Agent</EmptyTitle><EmptyDescription>Agent 服务尚未接入，当前不会自动执行任务。</EmptyDescription></EmptyHeader><Button variant="outline" size="sm" onClick={() => onView('all')}>查看团队任务</Button></Empty>
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{section === 'views' ? '工作区视图' : WORKSPACE_NAME}</h1><p className="text-sm text-muted-foreground">{section === 'views' ? '按工作流状态查看任务，不改变任务本身。' : '团队工作概览'}</p></header><div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => onView('favorites')}><Star data-icon="inline-start" />收藏的任务 · {counts.favorites}</Button><Button variant="outline" onClick={() => onView('following')}><Bell data-icon="inline-start" />关注的任务 · {counts.following}</Button></div><div className="grid gap-3 sm:grid-cols-2">{ISSUE_STATUSES.map(status => <Button key={status.value} variant="outline" className="h-14 justify-start gap-3" onClick={() => onView(status.value)}><status.icon data-icon="inline-start" /><span>{status.label}</span><span className="ml-auto text-muted-foreground">{counts[status.value]}</span></Button>)}</div>{section === 'team-home' && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={onProjects}><Layers data-icon="inline-start" />查看项目 · {projectCount}</Button><Button variant="outline" onClick={() => onView('all')}>查看全部任务 · {counts.all}</Button></div>}</div>
}
