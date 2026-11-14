'use client'
import { useTranslations } from 'next-intl'

import { useViewState } from '@/lib/hooks/view-state'
import { useAgentCopy } from '@/hooks/use-agent-copy'
import { useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Box, Plus } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import dynamic from 'next/dynamic'

import { PROJECT_STATUSES, PROJECT_ICON_TINTS, projectTaskCounts, type ProjectTaskPaging, type Project } from './project-properties'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { projectDirectory, ProjectPropertyControl } from './project-property-controls'
import { useProjectUpdate } from './use-project-update'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { usePresence } from '@/lib/use-presence'
import { navigate } from './workspace-navigation'
import { SearchInput } from '@/components/ui/search-input'

const ProjectForm = dynamic(() => import('./project-form').then(module => module.ProjectForm), {
  loading: () => { const agentCopy = useAgentCopy(); return (<p role="status" className="p-6 text-sm text-muted-foreground">{agentCopy.loadingProjectForm}</p>) },
})
const ProjectDetail = dynamic(() => import('./project-detail').then(module => module.ProjectDetail), {
  loading: () => { const agentCopy = useAgentCopy(); return (<div role="status" aria-label={agentCopy.loadingProjectDetails} className="flex flex-col gap-6 p-6"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-40 w-full" /></div>) },
})

export function ProjectWorkspace({ readerId, paging, projects, loading, error, projectId, team, initialTeamId, issues, workspace, onSelect, onOpenTeam, onOpenIssue, onCreateIssue, onUpdated }: {
  readerId: string; paging: ProjectTaskPaging; projects: Project[]; loading: boolean; error: boolean; projectId: string | null; team?: string; initialTeamId?: string; issues: Awaited<ReturnType<typeof listIssues>>; workspace?: WorkspaceSettings; onSelect: (id: string | null) => void; onOpenTeam: () => void; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void; onUpdated: () => void
}) {
  const i18nText = useTranslations();
  const directory = useMemo(() => projectDirectory(workspace), [workspace])
  const [creating, setCreating] = useState(false)
  const createDialog = usePresence(creating)
  const { update, pending, error: saveError } = useProjectUpdate(onUpdated)
  const [query, setQuery] = useViewState(`projects:${initialTeamId ?? 'all'}:query`, '')
  const [status, setStatus] = useViewState(`projects:${initialTeamId ?? 'all'}:status`, 'all')
  const [archived, setArchived] = useState(false)
  const [ascending, setAscending] = useViewState(`projects:${initialTeamId ?? 'all'}:ascending`, true)
  const project = projects.find(item => item.id === projectId)
  const filtered = projects.filter(item => Boolean(item.archivedAt) === archived && (status === 'all' || item.status === status) && item.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') * (ascending ? 1 : -1))
  if (error) return <Empty><EmptyHeader><EmptyTitle>{i18nText("Projects.loadErrorTitle")}</EmptyTitle></EmptyHeader><Button variant="outline" onClick={onUpdated}>{i18nText("Projects.reload")}</Button></Empty>
  if (loading) return <div role="status" aria-label={i18nText("Projects.loading")} className="flex flex-col gap-4 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
  if (project) return <ProjectDetail key={project.id} readerId={readerId} paging={paging} project={project} projects={projects} issues={issues} directory={directory} admin={workspace?.role === 'admin' && workspace.workspace.id === project.workspaceId} onBack={() => onSelect(null)} onOpenTeam={onOpenTeam} onOpenIssue={onOpenIssue} onCreateIssue={onCreateIssue} onUpdated={onUpdated} />
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><h1 className="text-sm font-medium">{team ? i18nText("FeatureCopy.c_4099b448", { value0: (team) }) : i18nText("Projects.title")}</h1><Button size="sm" variant="ghost" onClick={() => setCreating(true)}><Plus data-icon="inline-start" />{i18nText("Projects.form.createTitle")}</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"><span className="text-sm text-muted-foreground">{i18nText("FeatureCopy.c_e1b94a93")} {filtered.length}</span><div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" aria-pressed={archived} onClick={() => setArchived(value => !value)}>{i18nText("Projects.lifecycle.archived")}</Button><SearchInput aria-label={i18nText("Projects.search")} placeholder={i18nText("Projects.searchPlaceholder")} className="w-40 sm:w-48" value={query} onChange={event => setQuery(event.target.value)} /><NativeSelect aria-label={i18nText("Projects.filterStatus")} value={status} onChange={event => setStatus(event.target.value)}><NativeSelectOption value="all">{i18nText("Projects.allStatuses")}</NativeSelectOption>{PROJECT_STATUSES.map(item => <NativeSelectOption key={item.value} value={item.value}>{({ backlog: i18nText("Projects.status.backlog"), planned: i18nText("FeatureCopy.c_0e4cd337"), started: i18nText("Projects.status.started"), paused: i18nText("Projects.status.paused"), completed: i18nText("Projects.status.completed"), canceled: i18nText("Projects.status.canceled") } as const)[item.value]}</NativeSelectOption>)}</NativeSelect></div></div>
    {saveError && <Alert variant="destructive" className="mx-5 mb-3 w-auto"><AlertDescription>{saveError}</AlertDescription></Alert>}
    {pending && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground">{i18nText("Projects.savingProperties")}</p>}
    {filtered.length ? <div className="px-3"><Table><TableHeader><TableRow><TableHead className="w-2/5"><Button variant="ghost" size="sm" onClick={() => setAscending(value => !value)}>{i18nText("Settings.workspaceForm.name")}{ascending ? <ArrowDownAZ data-icon="inline-end" /> : <ArrowUpAZ data-icon="inline-end" />}</Button></TableHead><TableHead>{i18nText("Projects.fields.health")}</TableHead><TableHead>{i18nText("Projects.fields.priority")}</TableHead><TableHead>{i18nText("Projects.fields.lead")}</TableHead><TableHead>{i18nText("Projects.fields.targetDate")}</TableHead><TableHead className="text-right">{i18nText("Projects.detail.issues")}</TableHead><TableHead>{i18nText("Projects.fields.status")}</TableHead></TableRow></TableHeader><TableBody>{filtered.map(item => {
      const counts = projectTaskCounts(item, issues)
      return <TableRow key={item.id}><TableCell><Button variant="ghost" className="h-auto w-full justify-start py-3 text-left whitespace-normal" onClick={() => onSelect(item.id)}><Box data-icon="inline-start" className={PROJECT_ICON_TINTS[item.properties.color]} /><span className="line-clamp-2">{item.name}</span></Button></TableCell><TableCell><ProjectPropertyControl field="health" value={item} directory={directory} disabled={pending || Boolean(item.archivedAt)} plain onChange={changes => void update(item, changes)} /></TableCell>{(['priority', 'lead', 'targetDate'] as const).map(field => <TableCell key={field}><ProjectPropertyControl field={field} projectId={item.id} value={item} directory={directory} disabled={pending || Boolean(item.archivedAt)} plain onChange={changes => void update(item, changes)} /></TableCell>)}<TableCell className="text-right">{counts?.total ?? '—'}</TableCell><TableCell><div className="inline-flex items-center gap-2"><ProjectPropertyControl field="status" value={item} directory={directory} disabled={pending || Boolean(item.archivedAt)} plain onChange={changes => void update(item, changes)} /><span className="text-xs text-muted-foreground">{counts ? `${counts.total ? Math.round(counts.done / counts.total * 100) : 0}%` : '—'}</span></div></TableCell></TableRow>
    })}</TableBody></Table></div> : <Empty className="min-h-80"><EmptyHeader><EmptyMedia variant="icon"><Box /></EmptyMedia><EmptyTitle>{archived || query || status !== 'all' ? i18nText("Projects.noMatchTitle") : i18nText("Projects.emptyTitle")}</EmptyTitle></EmptyHeader>{!archived && <EmptyContent><Button size="sm" onClick={() => setCreating(true)}><Plus data-icon="inline-start" />{i18nText("Projects.form.createTitle")}</Button></EmptyContent>}</Empty>}
    {createDialog.value && <ProjectForm open={createDialog.open} onOpenChangeComplete={createDialog.onOpenChangeComplete} initialTeamId={initialTeamId} projects={projects} directory={directory} onClose={() => setCreating(false)} onSaved={(saved, attachedTeamId) => {
      setCreating(false)
      onUpdated()
      if (initialTeamId && attachedTeamId !== initialTeamId) {
        navigate({ section: 'projects', team: null, project: saved.id })
      } else {
        onSelect(saved.id)
      }
    }} />}
  </div>
}
