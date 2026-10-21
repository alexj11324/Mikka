'use client'

import { useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Box, Plus } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import dynamic from 'next/dynamic'

import { PROJECT_STATUSES, PROJECT_ICON_TINTS, type Project } from './project-properties'
import { ProjectPropertyControl } from './project-property-controls'
import { useProjectUpdate } from './use-project-update'
import { Alert, AlertDescription } from '@/components/ui/alert'

const ProjectForm = dynamic(() => import('./project-form').then(module => module.ProjectForm), {
  loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">正在加载项目表单…</p>,
})
const ProjectDetail = dynamic(() => import('./project-detail').then(module => module.ProjectDetail), {
  loading: () => <div role="status" aria-label="正在加载项目详情" className="flex flex-col gap-6 p-6"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-40 w-full" /></div>,
})

export function ProjectWorkspace({ projects, loading, error, projectId, team, issues, userName, onSelect, onOpenTeam, onOpenIssue, onCreateIssue, onUpdated }: {
  projects: Project[]; loading: boolean; error: boolean; projectId: string | null; team?: string; issues: Awaited<ReturnType<typeof listIssues>>; userName: string; onSelect: (id: string | null) => void; onOpenTeam: () => void; onOpenIssue: (id: string) => boolean; onCreateIssue: () => void; onUpdated: () => void
}) {
  const t = useTranslations('Projects')
  const locale = useLocale()
  const [creating, setCreating] = useState(false)
  const { update, pending, error: saveError } = useProjectUpdate(onUpdated)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [ascending, setAscending] = useState(true)
  const project = projects.find(item => item.id === projectId)
  const statusLabel = (value: string) => t.has(`status.${value}` as never) ? t(`status.${value}` as never) : value
  const filtered = projects.filter(item => (!team || item.team === team) && (status === 'all' || item.status === status) && item.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name, locale) * (ascending ? 1 : -1))
  if (error) return <Empty><EmptyHeader><EmptyTitle>{t('loadErrorTitle')}</EmptyTitle><EmptyDescription>{t('loadErrorDescription')}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={onUpdated}>{t('reload')}</Button></Empty>
  if (loading) return <div role="status" aria-label={t('loading')} className="flex flex-col gap-4 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
  if (project) return <ProjectDetail key={project.id} project={project} projects={projects} issues={issues} userName={userName} onBack={() => onSelect(null)} onOpenTeam={() => { setQuery(''); setStatus('all'); onOpenTeam() }} onOpenIssue={onOpenIssue} onCreateIssue={onCreateIssue} onUpdated={onUpdated} />
  return <div className="flex min-w-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><h1 className="text-sm font-medium">{team ? t('teamTitle', { team }) : t('title')}</h1><Button size="sm" variant="ghost" onClick={() => setCreating(true)}><Plus data-icon="inline-start" />{t('newProject')}</Button></div>
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"><span className="text-sm text-muted-foreground">{t('allProjects', { count: filtered.length })}</span><div className="flex items-center gap-2"><Input aria-label={t('search')} placeholder={t('searchPlaceholder')} className="w-40 sm:w-48" value={query} onChange={event => setQuery(event.target.value)} /><NativeSelect aria-label={t('filterStatus')} value={status} onChange={event => setStatus(event.target.value)}><NativeSelectOption value="all">{t('allStatuses')}</NativeSelectOption>{PROJECT_STATUSES.map(item => <NativeSelectOption key={item.value} value={item.value}>{statusLabel(item.value)}</NativeSelectOption>)}</NativeSelect></div></div>
    {saveError && <Alert variant="destructive" className="mx-5 mb-3 w-auto"><AlertDescription>{saveError}</AlertDescription></Alert>}
    {pending && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground">{t('savingProperties')}</p>}
    {filtered.length ? <div className="px-3"><Table><TableHeader><TableRow><TableHead className="w-2/5"><Button variant="ghost" size="sm" onClick={() => setAscending(value => !value)}>{t('columns.name')}{ascending ? <ArrowDownAZ data-icon="inline-end" /> : <ArrowUpAZ data-icon="inline-end" />}</Button></TableHead><TableHead>{t('columns.health')}</TableHead><TableHead>{t('columns.priority')}</TableHead><TableHead>{t('columns.lead')}</TableHead><TableHead>{t('columns.targetDate')}</TableHead><TableHead className="text-right">{t('columns.tasks')}</TableHead><TableHead>{t('columns.status')}</TableHead></TableRow></TableHeader><TableBody>{filtered.map(item => {
      const linked = issues.filter(issue => item.issueIds.includes(issue.id))
      const completed = linked.filter(issue => issue.status === 'done').length
      return <TableRow key={item.id}><TableCell><Button variant="ghost" className="h-auto w-full justify-start py-3 text-left whitespace-normal" onClick={() => onSelect(item.id)}><Box data-icon="inline-start" className={PROJECT_ICON_TINTS[item.properties.color]} /><span className="line-clamp-2">{item.name}</span></Button></TableCell><TableCell><ProjectPropertyControl field="health" value={item} userName={userName} disabled={pending} plain onChange={changes => void update(item, changes)} /></TableCell>{(['priority', 'lead', 'targetDate'] as const).map(field => <TableCell key={field}><ProjectPropertyControl field={field} value={item} userName={userName} disabled={pending} plain onChange={changes => void update(item, changes)} /></TableCell>)}<TableCell className="text-right">{linked.length}</TableCell><TableCell><div className="inline-flex items-center gap-2"><ProjectPropertyControl field="status" value={item} userName={userName} disabled={pending} plain onChange={changes => void update(item, changes)} /><span className="text-xs text-muted-foreground">{linked.length ? Math.round(completed / linked.length * 100) : 0}%</span></div></TableCell></TableRow>
    })}</TableBody></Table></div> : <Empty className="min-h-80"><EmptyHeader><EmptyMedia variant="icon"><Box /></EmptyMedia><EmptyTitle>{query || status !== 'all' ? t('noMatchTitle') : t('emptyTitle')}</EmptyTitle><EmptyDescription>{query || status !== 'all' ? t('noMatchDescription') : t('emptyDescription')}</EmptyDescription></EmptyHeader><EmptyContent><Button size="sm" onClick={() => setCreating(true)}><Plus data-icon="inline-start" />{t('newProject')}</Button></EmptyContent></Empty>}
    {creating && <ProjectForm projects={projects} userName={userName} onClose={() => setCreating(false)} onSaved={saved => { setCreating(false); onUpdated(); onSelect(saved.id) }} />}
  </div>
}
