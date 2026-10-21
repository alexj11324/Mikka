'use client'

import { Inbox, Layers } from 'lucide-react'
import { AgentEmbed } from './agent-embed'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from './issue-properties'
import type { WorkspaceSection } from './workspace-navigation'

export function WorkspaceOverview({ section, counts, projectCount, onView, onProjects }: { section: WorkspaceSection; counts: Record<IssueView, number>; projectCount: number; onView: (view: IssueView) => void; onProjects: () => void }) {
  if (section === 'agent') return <AgentEmbed />
  if (section === 'inbox') return <Empty className="min-h-96"><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>收件箱</EmptyTitle><EmptyDescription>通知服务尚未接入。现有协作任务可以在团队任务中查看。</EmptyDescription></EmptyHeader><Button variant="outline" size="sm" onClick={() => onView('all')}>查看团队任务</Button></Empty>
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{section === 'views' ? '工作区视图' : WORKSPACE_NAME}</h1><p className="text-sm text-muted-foreground">{section === 'views' ? '按工作流状态查看任务，不改变任务本身。' : '团队工作概览'}</p></header><div className="grid gap-3 sm:grid-cols-2">{ISSUE_STATUSES.map(status => <Button key={status.value} variant="outline" className="h-14 justify-start gap-3" onClick={() => onView(status.value)}><status.icon data-icon="inline-start" /><span>{status.label}</span><span className="ml-auto text-muted-foreground">{counts[status.value]}</span></Button>)}</div>{section === 'team-home' && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={onProjects}><Layers data-icon="inline-start" />查看项目 · {projectCount}</Button><Button variant="outline" onClick={() => onView('all')}>查看全部任务 · {counts.all}</Button></div>}</div>
}
