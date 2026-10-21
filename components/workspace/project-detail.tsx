'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { ArrowLeft, Box, PanelRight, Pencil, Plus, Link2, History, SquareUserRound } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { listProjectEvents } from '@/app/actions/projects'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { IssueList } from './issue-list'
import { ProjectForm } from './project-form'
import { ProjectIssuePicker } from './project-issue-picker'
import { PROJECT_ICON_COLORS, PROJECT_ICON_TINTS, type Project } from './project-properties'
import { cn } from '@/lib/utils'
import { ProjectPropertyControl } from './project-property-controls'
import { useProjectUpdate } from './use-project-update'
import { ProjectTextEditor } from './project-text-editor'
import { WORKSPACE_NAME, WORKSPACE_TEAM_KEY } from './issue-properties'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function ProjectDetail({ project, projects, issues, userName, onBack, onOpenTeam, onOpenIssue, onCreateIssue, onUpdated }: { project: Project; projects: Project[]; issues: Awaited<ReturnType<typeof listIssues>>; userName: string; onBack: () => void; onOpenTeam: () => void; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void; onUpdated: () => void }) {
  const t = useTranslations('Projects')
  const format = useFormatter()
  const [editing, setEditing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [showDetails, setShowDetails] = useState(true)
  const [tab, setTab] = useState('overview')
  const { update, pending, error: saveError } = useProjectUpdate(onUpdated)
  const teamLabel = project.team === WORKSPACE_TEAM_KEY ? WORKSPACE_NAME : project.team
  const flushes = useRef(new Map<string, () => Promise<boolean>>())
  async function afterSave(action: () => void) {
    const results = await Promise.all([...flushes.current.values()].map(flush => flush()))
    if (results.every(Boolean)) action()
  }
  function registerFlush(field: string, flush: (() => Promise<boolean>) | null) {
    if (flush) flushes.current.set(field, flush)
    else flushes.current.delete(field)
  }
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
  function eventField(field: string): string {
    switch (field) {
      case 'status': return t('fields.status')
      case 'priority': return t('fields.priority')
      case 'lead': return t('fields.lead')
      case 'startDate': return t('fields.startDate')
      case 'targetDate': return t('fields.targetDate')
      case 'properties': return t('fields.properties')
      case 'name': return t('fields.name')
      case 'summary': return t('fields.summary')
      case 'description': return t('fields.description')
      case 'team': return t('fields.team')
      default: return field
    }
  }
  function eventMessage(message: string): string {
    if (message === 'project.created') return t('activity.created')
    if (message === 'project.updated') return t('activity.updatedOverview')
    if (message === 'project.tasksAdded') return t('activity.tasksAdded')
    if (message === 'project.tasksRemoved') return t('activity.tasksRemoved')
    if (message.startsWith('project.tasksUpdated:')) return t('activity.tasksUpdated', { count: Number(message.slice('project.tasksUpdated:'.length)) || 0 })
    if (message.startsWith('project.updatedFields:')) return t('activity.updatedFields', { fields: format.list(message.slice('project.updatedFields:'.length).split(',').filter(Boolean).map(eventField), { type: 'conjunction' }) })
    return message
  }
  const activity = <div className="flex flex-col gap-5">{error ? <Button variant="outline" onClick={() => void mutate()}>{t('detail.activityFailed')}</Button> : !events ? <p role="status" className="text-sm text-muted-foreground">{t('detail.readingActivity')}</p> : events.map(event => <div key={event.id} className="flex items-start gap-3 text-sm"><History className="mt-1 size-4 shrink-0 text-muted-foreground" /><div className="flex flex-col gap-1"><p>{userName} {eventMessage(event.message)}</p><time className="text-xs text-muted-foreground" dateTime={new Date(event.createdAt).toISOString()}>{format.dateTime(new Date(event.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</time></div></div>)}</div>
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 px-4 py-2"><div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label={t('detail.backToList')} onClick={() => { void afterSave(onBack) }}><ArrowLeft data-icon="inline-start" /></Button><Box className={cn('size-4 shrink-0', PROJECT_ICON_TINTS[project.properties.color])} /><span className="truncate text-sm">{project.name}</span></div><Button variant="ghost" size="sm" onClick={() => { void afterSave(() => setEditing(true)) }}><Pencil data-icon="inline-start" />{t('detail.edit')}</Button></div>
    <Tabs value={tab} onValueChange={value => { void afterSave(() => setTab(String(value))) }} className="min-w-0 flex-1 gap-0">
      <div className="flex items-center justify-between gap-3 px-4 py-3"><TabsList><TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger><TabsTrigger value="activity">{t('detail.activity')}</TabsTrigger><TabsTrigger value="issues">{t('detail.issues')}<Badge variant="secondary">{linked.length}</Badge></TabsTrigger></TabsList><Button variant="ghost" size="icon-sm" aria-label={t('detail.toggleDetails')} aria-pressed={showDetails} title="⌘ / Ctrl I" onClick={() => setShowDetails(value => !value)}><PanelRight data-icon="inline-start" /></Button></div>
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1">
          <TabsContent value="overview" className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8 sm:px-12 lg:py-16">
            <div className="flex flex-col items-start gap-4"><Button variant="ghost" size="icon-lg" aria-label={t('detail.editIconName')} onClick={() => { void afterSave(() => setEditing(true)) }} className={PROJECT_ICON_COLORS[project.properties.color]}><Box data-icon="inline-start" /></Button><ProjectTextEditor key={`${project.id}-name`} field="name" value={project.name} onSave={name => update(project, { name })} onRegisterFlush={flush => registerFlush('name', flush)} /></div>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="mr-1 text-muted-foreground">{t('detail.properties')}</span>{(['status', 'priority', 'lead', 'members', 'startDate', 'targetDate', 'labels', 'dependencyIds'] as const).map(field => <ProjectPropertyControl key={field} field={field} value={project} userName={userName} projects={projects} projectId={project.id} disabled={pending} onChange={changes => void update(project, changes)} />)}<Button variant="secondary" size="sm" className="h-7 rounded-full px-2" aria-label={t('detail.openTeamProject', { team: teamLabel })} onClick={() => { void afterSave(onOpenTeam) }}><SquareUserRound data-icon="inline-start" />{teamLabel}</Button></div>
            {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}
            {pending && <p role="status" className="text-xs text-muted-foreground">{t('detail.saving')}</p>}
            <section aria-labelledby="project-description-heading" className="flex min-w-0 flex-col gap-4"><h2 id="project-description-heading" className="text-sm font-medium text-muted-foreground">{t('detail.description')}</h2><ProjectTextEditor key={`${project.id}-description`} field="description" value={project.description || project.summary} onSave={description => update(project, { description })} onRegisterFlush={flush => registerFlush('description', flush)} /></section>
            <section className="flex flex-col gap-3"><div className="flex items-center justify-between"><h2 className="text-sm font-medium text-muted-foreground">{t('detail.milestones')}</h2><Button variant="ghost" size="sm" onClick={() => { void afterSave(() => setEditing(true)) }}><Plus data-icon="inline-start" />{t('detail.addMilestone')}</Button></div>{project.properties.milestones.length ? project.properties.milestones.map(item => <div key={item.id} className="flex items-center gap-3 py-3"><Checkbox aria-label={t('detail.milestoneDone', { name: item.name })} checked={item.completed} disabled={pending} onCheckedChange={checked => void update(project, { properties: { ...project.properties, milestones: project.properties.milestones.map(value => value.id === item.id ? { ...value, completed: Boolean(checked) } : value) } })} /><span className={cn('flex-1 text-sm', item.completed && 'text-muted-foreground line-through')}>{item.name}</span><time className="text-xs text-muted-foreground" dateTime={item.targetDate || undefined}>{item.targetDate ? format.dateTime(new Date(`${item.targetDate}T00:00:00`), { dateStyle: 'medium' }) : t('detail.unsetDate')}</time></div>) : <p className="text-sm text-muted-foreground">{t('detail.noMilestones')}</p>}</section>
          </TabsContent>
          <TabsContent value="activity" className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-12">{activity}</TabsContent>
          <TabsContent value="issues"><div className="flex justify-end gap-2 px-4 py-3"><Button size="sm" variant="outline" onClick={() => setLinking(true)}><Link2 data-icon="inline-start" />{t('detail.linkIssues')}</Button><Button size="sm" onClick={onCreateIssue}><Plus data-icon="inline-start" />{t('detail.newIssue')}</Button></div><IssueList issues={linked} searching onOpen={onOpenIssue} onCreate={onCreateIssue} /></TabsContent>
        </div>
        {showDetails && <aside aria-label={t('detail.detailsLabel')} className="flex w-full shrink-0 flex-col gap-7 px-5 py-6 lg:w-64 lg:border-l xl:w-72">
          <section className="flex flex-col gap-4"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{t('detail.properties')}</h2><Button variant="ghost" size="icon-sm" aria-label={t('detail.editProperties')} onClick={() => { void afterSave(() => setEditing(true)) }}><Pencil data-icon="inline-start" /></Button></div><dl className="flex flex-col gap-2 text-sm">{([{ field: 'status', label: t('fields.status') }, { field: 'health', label: t('fields.health') }, { field: 'priority', label: t('fields.priority') }, { field: 'lead', label: t('fields.lead') }, { field: 'members', label: t('fields.members') }, { field: 'startDate', label: t('fields.startDate') }, { field: 'targetDate', label: t('fields.targetDate') }, { field: 'labels', label: t('fields.labels') }, { field: 'dependencyIds', label: t('fields.dependencyIds') }] as const).map(({ field, label }) => <div key={field} className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0"><ProjectPropertyControl field={field} value={project} userName={userName} projects={projects} projectId={project.id} disabled={pending} plain onChange={changes => void update(project, changes)} /></dd></div>)}<div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 py-2"><dt className="text-muted-foreground">{t('fields.team')}</dt><dd className="min-w-0"><Button variant="ghost" size="sm" className="h-7 max-w-full justify-start px-2" aria-label={t('detail.openTeam', { team: teamLabel })} onClick={() => { void afterSave(onOpenTeam) }}><SquareUserRound data-icon="inline-start" /><span className="truncate">{teamLabel}</span></Button></dd></div></dl>{saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}</section>
          <section className="flex flex-col gap-4"><h2 className="text-sm font-medium">{t('detail.progress')}</h2><div className="flex justify-between text-sm"><span className="text-muted-foreground">{t('detail.completedOf', { complete, total: linked.length })}</span><span>{progress}%</span></div><Progress value={progress} aria-label={t('detail.progressAria')} /><p className="text-xs text-muted-foreground">{t('detail.progressNote')}</p></section>
          <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">{t('detail.activity')}</h2><p className="text-xs text-muted-foreground">{t('detail.createdAt', { date: format.dateTime(new Date(project.createdAt), { dateStyle: 'medium' }) })}</p><Button variant="ghost" size="sm" onClick={() => { void afterSave(() => setTab('activity')) }}>{t('detail.viewAllActivity')}</Button></section>
        </aside>}
      </div>
    </Tabs>
    {editing && <ProjectForm project={project} projects={projects} userName={userName} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onUpdated() }} />}
    {linking && <ProjectIssuePicker project={project} projects={projects} issues={issues} onClose={() => setLinking(false)} onSaved={() => { setLinking(false); onUpdated() }} />}
  </div>
}
