'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, Box, PanelRight, Pencil, Plus, Link2, History } from 'lucide-react'
import { listProjectEvents } from '@/app/actions/projects'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { IssueList } from './issue-list'
import { ProjectForm } from './project-form'
import { ProjectIssuePicker } from './project-issue-picker'
import { PROJECT_STATUSES, type Project } from './project-properties'
import { ISSUE_PRIORITIES } from './issue-properties'

export function ProjectDetail({ project, projects, issues, userName, onBack, onOpenIssue, onCreateIssue, onUpdated }: { project: Project; projects: Project[]; issues: Awaited<ReturnType<typeof listIssues>>; userName: string; onBack: () => void; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [showDetails, setShowDetails] = useState(true)
  const [tab, setTab] = useState('overview')
  const { data: events, error, mutate } = useSWR(['project-events', project.id, project.revision], () => listProjectEvents(project.id))
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); setShowDetails(value => !value) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  const linked = issues.filter(issue => project.issueIds.includes(issue.id))
  const complete = linked.filter(issue => issue.status === 'done').length
  const progress = linked.length ? Math.round(complete / linked.length * 100) : 0
  const status = PROJECT_STATUSES.find(item => item.value === project.status) ?? PROJECT_STATUSES[0]
  const activity = <div className="flex flex-col gap-5">{error ? <Button variant="outline" onClick={() => void mutate()}>活动读取失败，重试</Button> : !events ? <p role="status" className="text-sm text-muted-foreground">正在读取活动…</p> : events.map(event => <div key={event.id} className="flex items-start gap-3 text-sm"><History className="mt-1 size-4 shrink-0 text-muted-foreground" /><div className="flex flex-col gap-1"><p>{userName} {event.message}</p><time className="text-xs text-muted-foreground" dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></div></div>)}</div>
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2"><div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="返回项目列表" onClick={onBack}><ArrowLeft data-icon="inline-start" /></Button><Box className="size-4 shrink-0 text-warning-foreground" /><span className="truncate text-sm">{project.name}</span></div><Button variant="ghost" size="sm" onClick={() => setEditing(true)}><Pencil data-icon="inline-start" />编辑项目</Button></div>
    <Tabs value={tab} onValueChange={value => setTab(String(value))} className="min-w-0 flex-1 gap-0">
      <div className="flex items-center justify-between gap-3 px-4 py-3"><TabsList><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="activity">活动</TabsTrigger><TabsTrigger value="issues">任务<Badge variant="secondary">{linked.length}</Badge></TabsTrigger></TabsList><Button variant="ghost" size="icon-sm" aria-label="切换项目属性侧栏" aria-pressed={showDetails} title="⌘ / Ctrl I" onClick={() => setShowDetails(value => !value)}><PanelRight data-icon="inline-start" /></Button></div>
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1">
          <TabsContent value="overview" className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8 sm:px-12 lg:py-16">
            <div className="flex flex-col items-start gap-4"><span className="flex size-11 items-center justify-center rounded-lg bg-warning/10 text-warning-foreground"><Box className="size-6" /></span><h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>{project.summary && <p className="text-sm leading-relaxed">{project.summary}</p>}</div>
            <div className="flex flex-wrap items-center gap-3 text-sm"><span className="text-muted-foreground">属性</span><Badge variant="outline"><status.icon />{status.label}</Badge><span>{ISSUE_PRIORITIES.find(item => item.value === project.priority)?.label}</span><span className="text-muted-foreground">{project.lead ? userName : '未指定负责人'}</span><Badge variant="secondary">{project.team}</Badge></div>
            <Separator />
            <section className="flex flex-col gap-4"><div className="flex items-center justify-between"><h2 className="text-sm font-medium text-muted-foreground">详细描述</h2><Button variant="ghost" size="sm" onClick={() => setEditing(true)}>编辑</Button></div><p className="whitespace-pre-wrap text-sm leading-relaxed">{project.description || '还没有项目描述。添加背景、范围与交付标准，让团队了解目标。'}</p></section>
            <section className="flex flex-col items-start gap-4"><h2 className="text-sm font-medium text-muted-foreground">项目任务</h2><p className="text-sm text-muted-foreground">{linked.length} 项可访问任务，{complete} 项已完成</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setLinking(true)}><Link2 data-icon="inline-start" />关联已有任务</Button><Button size="sm" variant="outline" onClick={onCreateIssue}><Plus data-icon="inline-start" />新建任务</Button></div></section>
          </TabsContent>
          <TabsContent value="activity" className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-12">{activity}</TabsContent>
          <TabsContent value="issues"><div className="flex justify-end gap-2 px-4 py-3"><Button size="sm" variant="outline" onClick={() => setLinking(true)}><Link2 data-icon="inline-start" />关联任务</Button><Button size="sm" onClick={onCreateIssue}><Plus data-icon="inline-start" />新建任务</Button></div><IssueList issues={linked} searching onOpen={onOpenIssue} onCreate={onCreateIssue} /></TabsContent>
        </div>
        {showDetails && <aside aria-label="项目属性" className="flex w-full shrink-0 flex-col gap-6 border-t p-5 lg:w-72 lg:border-t-0 xl:w-80">
          <section className="flex flex-col gap-5 rounded-xl border bg-card p-4"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">属性</h2><Button variant="ghost" size="icon-sm" aria-label="编辑项目属性" onClick={() => setEditing(true)}><Pencil data-icon="inline-start" /></Button></div><dl className="flex flex-col gap-5 text-sm">{[['状态', status.label], ['优先级', ISSUE_PRIORITIES.find(item => item.value === project.priority)?.label], ['负责人', project.lead ? userName : '未指定'], ['团队', project.team], ['开始日期', project.startDate || '未设置'], ['目标日期', project.targetDate || '未设置']].map(([label, value]) => <div key={label} className="grid grid-cols-2 gap-3"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}</dl></section>
          <section className="flex flex-col gap-4 rounded-xl border bg-card p-4"><h2 className="text-sm font-medium">进度</h2><div className="flex justify-between text-sm"><span className="text-muted-foreground">已完成 {complete} / {linked.length}</span><span>{progress}%</span></div><Progress value={progress} aria-label="项目任务完成进度" /><p className="text-xs text-muted-foreground">按当前可访问的项目任务统计</p></section>
          <section className="flex flex-col gap-3 rounded-xl border bg-card p-4"><h2 className="text-sm font-medium">活动</h2><p className="text-xs text-muted-foreground">创建于 {new Date(project.createdAt).toLocaleDateString('zh-CN')}</p><Button variant="ghost" size="sm" onClick={() => setTab('activity')}>查看全部活动</Button></section>
        </aside>}
      </div>
    </Tabs>
    {editing && <ProjectForm project={project} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onUpdated() }} />}
    {linking && <ProjectIssuePicker project={project} projects={projects} issues={issues} onClose={() => setLinking(false)} onSaved={() => { setLinking(false); onUpdated() }} />}
  </div>
}
