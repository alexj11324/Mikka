'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useLiveKey } from '@/hooks/use-live-key'
import { useTaskContinuation } from '@/lib/hooks/use-task-continuation'
import { ArrowLeft, Box, PanelRight, Pencil, Plus, Link2, History } from 'lucide-react'
import { ProjectLifecycleControls } from './project-lifecycle-controls'
import { ProjectTeamControl } from '@/components/teams/project-team-control'
import { listProjectEvents } from '@/app/actions/projects'
import { listWorkspaceTaskPage, type listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { IssueList } from './issue-list'
import { ProjectForm } from './project-form'
import { ProjectIssuePicker } from './project-issue-picker'
import { PROJECT_ICON_COLORS, PROJECT_ICON_TINTS, projectTaskCounts, type ProjectTaskPaging, type Project } from './project-properties'
import { cn } from '@/lib/utils'
import { ProjectPropertyControl, type ProjectDirectory } from './project-property-controls'
import { useProjectUpdate } from './use-project-update'
import { ProjectTextEditor } from './project-text-editor'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useShortcutLabel } from '@/components/shortcut-keys'
import { usePresence } from '@/lib/use-presence'
import { useViewState } from '@/lib/hooks/view-state'
import { ResizablePane } from '@/components/ui/resizable-pane'

function ProjectTaskList({ project, readerId, onOpen, onCreate }: { project: Project; readerId: string; onOpen: (id: string) => boolean; onCreate: () => void }) {
  const words = useTranslations()
  const key = ['project-task-page', readerId, project.workspaceId, project.id]
  const first = () => listWorkspaceTaskPage({ workspaceId: project.workspaceId, projectId: project.id, after: null })
  const { data, error, mutate } = useSWR(key, first)
  const cacheKeys = [unstable_serialize(key)]
  useLiveKey('issue_list', project.workspaceId, cacheKeys, project.workspaceId)
  useLiveKey('project_map', project.id, cacheKeys, project.workspaceId)
  const pages = useTaskContinuation(data?.items ?? [], data, data?.next ?? null, async after => {
    const next = await listWorkspaceTaskPage({ workspaceId: project.workspaceId, projectId: project.id, after })
    if (next.reset) { await mutate(); throw new Error('issueStale') }
    return next
  })
  if (error) return <Button variant="outline" onClick={() => void mutate()}>{words('Common.retry')}</Button>
  if (!data) return <p role="status">{words('Projects.loading')}</p>
  return <><IssueList issues={[...pages.items]} searching onOpen={onOpen} onCreate={onCreate} />
    {pages.hasMore && <Button variant="ghost" size="sm" disabled={pages.loading} onClick={() => void pages.loadMore()}>{pages.failed ? words('Common.retry') : words('HostedTasks.loadMore')}</Button>}
  </>
}

export function ProjectDetail({ readerId, paging, project, projects, issues, directory, admin, onBack, onOpenIssue, onCreateIssue, onUpdated }: { readerId: string; paging: ProjectTaskPaging; project: Project; projects: Project[]; issues: Awaited<ReturnType<typeof listIssues>>; directory: ProjectDirectory; admin: boolean; onBack: () => void; onOpenTeam: () => void; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void; onUpdated: () => void }) {
  const i18nText = useTranslations();
  const readOnly = project.canEditProperties === false || Boolean(project.archivedAt)
  const [editing, setEditing] = useState(false)
  const editDialog = usePresence(editing)
  const [linking, setLinking] = useState(false)
  const [showDetails, setShowDetails] = useViewState(`project:${project.id}:details`, true)
  const detailsShortcut = useShortcutLabel(['mod', 'I'])
  const [tab, setTab] = useViewState(`project:${project.id}:tab`, 'overview')
  const { update, pending, error: saveError } = useProjectUpdate(onUpdated)
  const flushes = useRef(new Map<string, () => Promise<boolean>>())
  async function flushChanges() {
    const results = await Promise.all([...flushes.current.values()].map(flush => flush()))
    return results.every(Boolean)
  }
  async function afterSave(action: () => void) {
    if (await flushChanges()) action()
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
  const counts = projectTaskCounts(project, issues)
  const progress = counts ? (counts.total ? Math.round(counts.done / counts.total * 100) : 0) : null
  const activity = <div className="flex flex-col gap-5">{error ? <Button variant="outline" onClick={() => void mutate()}>{i18nText("Projects.detail.activityFailed")}</Button> : !events ? <p role="status" className="text-sm text-muted-foreground">{i18nText("Projects.detail.readingActivity")}</p> : events.map(event => <div key={event.id} className="flex items-start gap-3 text-sm"><History className="mt-1 size-4 shrink-0 text-muted-foreground" /><div className="flex flex-col gap-1"><p>{event.actorName && <><bdi>{event.actorName}</bdi>{' '}</>}{event.message}</p><time className="text-xs text-muted-foreground" dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></div></div>)}</div>
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 px-4 py-2"><div className="flex min-w-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label={i18nText("Projects.detail.backToList")} onClick={() => { void afterSave(onBack) }}><ArrowLeft data-icon="inline-start" /></Button><Box className={cn('size-4 shrink-0', PROJECT_ICON_TINTS[project.properties.color])} /><span className="truncate text-sm">{project.name}</span>{project.archivedAt && <Badge variant="secondary">{i18nText("Projects.lifecycle.archived")}</Badge>}</div><div className="flex flex-wrap justify-end gap-2"><ProjectLifecycleControls key={`${readerId}:${project.workspaceId}:${project.id}`} project={project} readerId={readerId} admin={admin} beforeOpen={flushChanges} onUpdated={onUpdated} onDeleted={onBack} /><Button variant="ghost" size="sm" disabled={readOnly} onClick={() => { void afterSave(() => setEditing(true)) }}><Pencil data-icon="inline-start" />{i18nText("Projects.form.editTitle")}</Button></div></div>
    <Tabs value={tab} onValueChange={value => { void afterSave(() => setTab(String(value))) }} className="min-w-0 flex-1 gap-0">
      <div className="flex items-center justify-between gap-3 px-4 py-3"><TabsList><TabsTrigger value="overview">{i18nText("Projects.detail.overview")}</TabsTrigger><TabsTrigger value="activity">{i18nText("Projects.detail.activity")}</TabsTrigger><TabsTrigger value="issues">{i18nText("Projects.detail.issues")}<Badge variant="secondary">{counts?.total ?? '—'}</Badge></TabsTrigger></TabsList><Button variant="ghost" size="icon-sm" aria-label={i18nText("Projects.detail.toggleDetails")} aria-pressed={showDetails} title={detailsShortcut} onClick={() => setShowDetails(value => !value)}><PanelRight data-icon="inline-start" /></Button></div>
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1">
          <TabsContent value="overview" className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8 sm:px-12 lg:py-16">
            <div className="flex flex-col items-start gap-4"><Button variant="ghost" size="icon-lg" disabled={readOnly} aria-label={i18nText("Projects.detail.editIconName")} onClick={() => { void afterSave(() => setEditing(true)) }} className={PROJECT_ICON_COLORS[project.properties.color]}><Box data-icon="inline-start" /></Button><ProjectTextEditor key={`${project.id}-name`} field="name" readOnly={readOnly} value={project.name} onSave={name => update(project, { name })} onRegisterFlush={flush => registerFlush('name', flush)} /></div>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className="mr-1 text-muted-foreground">{i18nText("Projects.detail.properties")}</span>{(['status', 'priority', 'lead', 'members', 'startDate', 'targetDate', 'labels', 'dependencyIds'] as const).map(field => <ProjectPropertyControl key={field} field={field} value={project} directory={directory} projects={projects} projectId={project.id} disabled={pending} onChange={changes => void update(project, changes)} />)}</div>
            {saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}
            {pending && <p role="status" className="text-xs text-muted-foreground">{i18nText("Projects.detail.saving")}</p>}
            <section aria-labelledby="project-description-heading" className="flex min-w-0 flex-col gap-4"><h2 id="project-description-heading" className="text-sm font-medium text-muted-foreground">{i18nText("Projects.form.descriptionHeading")}</h2><ProjectTextEditor key={`${project.id}-description`} field="description" readOnly={readOnly} value={project.description || project.summary} onSave={description => update(project, { description })} onRegisterFlush={flush => registerFlush('description', flush)} /></section>
            <section className="flex flex-col gap-3"><div className="flex items-center justify-between"><h2 className="text-sm font-medium text-muted-foreground">{i18nText("Projects.milestones.title")}</h2><Button variant="ghost" size="sm" disabled={readOnly} onClick={() => { void afterSave(() => setEditing(true)) }}><Plus data-icon="inline-start" />{i18nText("Projects.milestones.add")}</Button></div>{project.properties.milestones.length ? project.properties.milestones.map(item => <div key={item.id} className="flex items-center gap-3 py-3"><Checkbox aria-label={i18nText("FeatureCopy.c_b8f12a94", { value0: (item.name) })} checked={item.completed} disabled={readOnly || pending} onCheckedChange={checked => void update(project, { properties: { ...project.properties, milestones: project.properties.milestones.map(value => value.id === item.id ? { ...value, completed: Boolean(checked) } : value) } })} /><span className={cn('flex-1 text-sm', item.completed && 'text-muted-foreground line-through')}>{item.name}</span><time className="text-xs text-muted-foreground" dateTime={item.targetDate || undefined}>{item.targetDate || i18nText("Projects.detail.unsetDate")}</time></div>) : <p className="text-sm text-muted-foreground">{i18nText("Projects.detail.noMilestones")}</p>}</section>
          </TabsContent>
          <TabsContent value="activity" className="mx-auto w-full max-w-4xl px-6 py-10 sm:px-12">{activity}</TabsContent>
          <TabsContent value="issues"><div className="flex justify-end gap-2 px-4 py-3"><Button size="sm" variant="outline" disabled={readOnly} onClick={() => setLinking(true)}><Link2 data-icon="inline-start" />{i18nText("Projects.detail.linkIssues")}</Button><Button size="sm" disabled={readOnly} onClick={onCreateIssue}><Plus data-icon="inline-start" />{i18nText("Projects.detail.newIssue")}</Button></div>{tab === 'issues' && (project.taskCounts ? <ProjectTaskList readerId={readerId} project={project} onOpen={onOpenIssue} onCreate={onCreateIssue} /> : <><IssueList issues={linked} searching onOpen={onOpenIssue} onCreate={onCreateIssue} />{paging.hasMore && <Button variant="ghost" disabled={paging.loading} onClick={() => void paging.loadMore()}>{paging.failed ? i18nText('Common.retry') : i18nText('HostedTasks.loadMore')}</Button>}</>)}</TabsContent>
        </div>
        {showDetails && <ResizablePane render="aside" aria-label={i18nText("Projects.detail.detailsLabel")} storageKey="mikka:project-details-width" defaultWidth={272} min={220} max={440} edge="start" from="lg" label={i18nText("Common.resize.projectDetails")} className="flex w-full shrink-0 flex-col gap-7 px-5 py-6 lg:border-l">
          <section className="flex flex-col gap-4"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{i18nText("Projects.detail.properties")}</h2><Button variant="ghost" size="icon-sm" disabled={readOnly} aria-label={i18nText("Projects.detail.editProperties")} onClick={() => { void afterSave(() => setEditing(true)) }}><Pencil data-icon="inline-start" /></Button></div><dl className="flex flex-col gap-2 text-sm">{([{ field: 'status', label: i18nText("Projects.fields.status") }, { field: 'health', label: i18nText("Projects.fields.health") }, { field: 'priority', label: i18nText("Projects.fields.priority") }, { field: 'lead', label: i18nText("Projects.fields.lead") }, { field: 'members', label: i18nText("Invite.roles.member") }, { field: 'startDate', label: i18nText("Projects.fields.startDate") }, { field: 'targetDate', label: i18nText("Projects.fields.targetDate") }, { field: 'labels', label: i18nText("Projects.fields.labels") }, { field: 'dependencyIds', label: i18nText("Projects.fields.dependencyIds") }] as const).map(({ field, label }) => <div key={field} className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0"><ProjectPropertyControl field={field} value={project} directory={directory} projects={projects} projectId={project.id} disabled={pending} plain onChange={changes => void update(project, changes)} /></dd></div>)}</dl>{saveError && <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert>}</section>
          <ProjectTeamControl project={project} disabled={readOnly || pending} onUpdated={onUpdated} />
          <section className="flex flex-col gap-4"><h2 className="text-sm font-medium">{i18nText("Projects.detail.progress")}</h2><div className="flex justify-between text-sm"><span className="text-muted-foreground">{i18nText("Projects.status.completed")} {counts ? `${counts.done} / ${counts.total}` : '—'}</span><span>{progress === null ? '—' : `${progress}%`}</span></div><Progress value={progress} aria-label={i18nText("Projects.detail.progressAria")} /></section>
          <section className="flex flex-col gap-3"><h2 className="text-sm font-medium">{i18nText("Projects.detail.activity")}</h2><p className="text-xs text-muted-foreground">{i18nText("Issue.createdAt")} {new Date(project.createdAt).toLocaleDateString('zh-CN')}</p><Button variant="ghost" size="sm" onClick={() => { void afterSave(() => setTab('activity')) }}>{i18nText("Projects.detail.viewAllActivity")}</Button></section>
        </ResizablePane>}
      </div>
    </Tabs>
    {!readOnly && editDialog.value && <ProjectForm open={editDialog.open} onOpenChangeComplete={editDialog.onOpenChangeComplete} project={project} projects={projects} directory={directory} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onUpdated() }} />}
    {!readOnly && linking && <ProjectIssuePicker paging={paging} project={project} projects={projects} issues={issues} onClose={() => setLinking(false)} onSaved={() => { setLinking(false); onUpdated() }} />}
  </div>
}
