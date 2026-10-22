'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useWorkspace } from '@/hooks/use-workspace'
import { useRouter } from '@/i18n/navigation'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from 'next-intl'
import { Columns3, List, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IssueBoard } from './issue-board'
import { AppSidebar } from '@/components/app-sidebar'
import { SettingsView } from '@/components/settings/settings-view'
import { AppShell, AppShellContent } from '@/components/app-shell'
import { IssueList } from './issue-list'
import { IssueSearch } from './issue-search'
import { ISSUE_STATUSES, WORKSPACE_NAME, issueIdentifier, type IssueStatus, type IssueView } from './issue-properties'
import { listIssues } from '@/app/actions/issues'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { listProjects, setProjectIssues } from '@/app/actions/projects'
import { ProjectWorkspace } from './project-workspace'
import { WorkspaceOverview } from './workspace-overview'
import type { WorkspaceSection } from './workspace-navigation'
import type { AgentHistory } from '@/lib/agent-history'

function DetailLoading() {
  const t = useTranslations('Workspace')
  return <div role="status" aria-label={t('loadingEditor')} className="flex flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-40 w-full" /></div>
}
function CreateLoading() {
  const t = useTranslations('Workspace')
  return <p role="status" className="p-6 text-sm text-muted-foreground">{t('loadingCreate')}</p>
}
const TaskDetail = dynamic(() => import('./task-detail').then(module => module.TaskDetail), { loading: DetailLoading })
const CreateIssueDialog = dynamic(() => import('./create-issue-dialog').then(module => module.CreateIssueDialog), { loading: CreateLoading })

export function IssueWorkspace({ user, initialIssues, initialSelected = null, initialAgentHistory, initialSection = 'projects', initialSettingsSection, googleEnabled }: { initialSelected?: string | null; user: { id: string; name: string; email: string; image?: string | null }; initialIssues: Awaited<ReturnType<typeof listIssues>>; initialAgentHistory?: AgentHistory; initialSection?: WorkspaceSection; initialSettingsSection?: 'integrations'; googleEnabled: boolean }) {
  const { data: workspaceData } = useWorkspace(user.email)
  const t = useTranslations('Workspace')
  const tIssue = useTranslations('Issue')
  const tNav = useTranslations('Nav')
  const tOverview = useTranslations('Overview')
  const sectionTitles: Record<WorkspaceSection, string> = {
    inbox: tOverview('sections.inbox'),
    'my-issues': tOverview('sections.myIssues'),
    agent: tOverview('sections.agent'),
    coordinator: tOverview('sections.coordinator'),
    projects: tOverview('sections.projects'),
    views: tOverview('sections.views'),
    'team-home': tOverview('sections.teamHome'),
    'team-issues': tOverview('sections.teamIssues'),
    'team-projects': tOverview('sections.teamProjects'),
    'all-issues': tOverview('sections.allIssues'),
  }
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsSection === 'integrations')
  const [settingsTarget, setSettingsTarget] = useState<{ section: 'preferences' | 'members' | 'integrations'; invite: boolean }>({ section: initialSettingsSection ?? 'preferences', invite: false })
  const [boardBusy, setBoardBusy] = useState(false)
  const { data: tasks = [], mutate, error } = useSWR(['issues', user.id], listIssues, { fallbackData: initialIssues, revalidateOnMount: false, refreshInterval: boardBusy ? 0 : 10000, revalidateOnFocus: !boardBusy, revalidateOnReconnect: !boardBusy })
  const { data: projects = [], error: projectError, isLoading: projectsLoading, mutate: refreshProjects } = useSWR(['projects', user.id], listProjects)
  const [section, setSection] = useState<WorkspaceSection>(initialSection)
  function changeSection(next: WorkspaceSection) {
    setSection(next)
    const url = new URL(window.location.href)
    if (next === 'agent') url.searchParams.set('section', 'agent')
    else url.searchParams.delete('section')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const [projectId, setProjectId] = useState<string | null>(null)
  const [creationProject, setCreationProject] = useState<string | null>(null)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo')
  const [selected, setSelected] = useState<string | null>(initialSelected)
  const [draftKey, setDraftKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const flushDetail = useRef<(() => Promise<boolean>) | null>(null)
  const leaving = useRef(false)
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => { flushDetail.current = flush }, [])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<IssueView>('all')
  const [creating, setCreating] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || boardBusy || settingsOpen) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault(); setSearchOpen(value => !value)
      } else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))) {
        event.preventDefault(); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreateStatus(ISSUE_STATUSES.some(status => status.value === view) ? view as IssueStatus : 'todo'); setCreating(true)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [creating, searchOpen, view, boardBusy, settingsOpen, section, projectId])
  const [signingOut, setSigningOut] = useState(false)
  const [accountError, setAccountError] = useState('')
  const router = useRouter()
  const onDirty = useCallback((value: boolean) => setDirty(value), [])
  async function leave(action: () => void | Promise<void>) {
    leaving.current = true
    try {
      if (flushDetail.current) {
        if (!await flushDetail.current()) return
      } else if (dirty) return
      setDirty(false)
      await action()
    } finally { leaving.current = false }
  }
  function closeSettings() {
    setSettingsOpen(false)
    const url = new URL(window.location.href)
    if (!url.searchParams.has('settings')) return
    url.searchParams.delete('settings')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  function showIssue(id: string | null) {
    setSelected(id); setDraftKey(value => value + 1)
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('issue', id)
    else url.searchParams.delete('issue')
    window.history.replaceState(null, '', url)
  }
  function open(id: string | null) {
    if (boardBusy || leaving.current) return false
    void leave(() => showIssue(id))
    return true
  }
  function deleted() {
    flushDetail.current = null
    setDirty(false)
    showIssue(null)
  }
  const saved = useCallback((id: string) => { setSelected(id); void mutate() }, [mutate])
  function create(status: IssueStatus = ISSUE_STATUSES.some(item => item.value === view) ? view as IssueStatus : 'todo') { if (boardBusy) return; setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreateStatus(status); setCreating(true) }
  async function issueCreated(id: string) {
    void mutate()
    if (!creationProject) return
    try {
      const latest = (await listProjects()).find(project => project.id === creationProject)
      if (!latest) throw new Error('project missing')
      const result = await setProjectIssues({ id: latest.id, revision: latest.revision, issueIds: [...latest.issueIds, id] })
      if (result.error) throw new Error(result.error)
      await refreshProjects()
    } catch { setAccountError(t('projectLinkFailed')) }
  }
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        const result = await authClient.signOut()
        if (result.error) throw new Error('sign out failed')
        await mutate([], { revalidate: false }); router.replace('/sign-in?login=1'); router.refresh()
      } catch { setAccountError(t('signOutFailed')); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(null); if (['inbox', 'agent', 'coordinator', 'views', 'team-home'].includes(section)) changeSection('team-issues'); setView(next); setQuery(''); setDraftKey(value => value + 1) })
    return true
  }
  function navigateSection(next: WorkspaceSection) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(null); changeSection(next); setProjectId(null); setView(next === 'my-issues' ? 'mine' : 'all'); setQuery(''); setDraftKey(value => value + 1) })
    return true
  }
  const isProjects = section === 'projects' || section === 'team-projects'
  const isOverview = ['inbox', 'agent', 'coordinator', 'views', 'team-home'].includes(section)
  const filtered = tasks.filter(task => (view === 'all' || (view === 'mine' ? task.ownerId === user.id : view === 'shared' ? task.ownerId !== user.id : view === 'favorites' ? task.metadata.favoriteUserIds.includes(user.id) : view === 'following' ? task.metadata.subscriberUserIds.includes(user.id) : task.status === view)) && `${issueIdentifier(task.metadata.number, tIssue('unassignedNumber'))} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()))
  const counts: Record<IssueView, number> = { all: tasks.length, mine: 0, shared: 0, favorites: 0, following: 0, backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0, duplicate: 0 }
  for (const task of tasks) {
    if (ISSUE_STATUSES.some(status => status.value === task.status)) counts[task.status as IssueStatus]++
    counts[task.ownerId === user.id ? 'mine' : 'shared']++
    if (task.metadata.favoriteUserIds.includes(user.id)) counts.favorites++
    if (task.metadata.subscriberUserIds.includes(user.id)) counts.following++
  }
  const viewTitle = view === 'all' ? t('allIssues') : view === 'mine' ? t('mine') : view === 'shared' ? t('shared') : view === 'favorites' ? t('favorites') : view === 'following' ? t('following') : statusLabel(view)
  return <AppShell fixed={!settingsOpen && !selected && (section === 'agent' || section === 'coordinator' || (!isProjects && !isOverview && layout === 'board'))}>
    {settingsOpen ? <SettingsView initialSection={settingsTarget.section} inviteInitially={settingsTarget.invite} user={user} googleEnabled={googleEnabled} onBack={closeSettings} onSignOut={signOut} signingOut={signingOut} accountError={accountError} /> : <>
    <AppSidebar onWorkspaceChange={async () => { if (boardBusy || leaving.current) return false; let allowed = false; await leave(() => { setSelected(null); setProjectId(null); setQuery(''); allowed = true }); return allowed }} onSettings={(section = 'preferences', invite = false) => { if (!boardBusy && !leaving.current) void leave(() => { setSettingsTarget({ section, invite }); setSettingsOpen(true) }) }} user={user} section={section} onNavigate={navigateSection} onSearch={() => { if (!boardBusy) setSearchOpen(true) }} onCreate={() => create()} onSignOut={signOut} signingOut={signingOut} />
    <AppShellContent hideHeader={!!selected || section === 'agent'} parent={workspaceData?.workspace.name ?? tNav('workspace')} title={sectionTitles[section]} actions={<Button variant="ghost" size="icon-sm" aria-label={t('openSearch')} disabled={boardBusy} onClick={() => setSearchOpen(true)}><Search data-icon="inline-start" /></Button>}>
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {error && <p role="alert" className="px-6 py-2 text-xs text-destructive">{t('listError')}</p>}
      {selected ? <TaskDetail key={draftKey} id={selected} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} onDeleted={deleted} onOpen={id => open(id)} navigation={{ index: filtered.findIndex(task => task.id === selected), total: filtered.length, onOpen: offset => { const index = filtered.findIndex(task => task.id === selected); const next = filtered[index + offset]; if (index >= 0 && next) open(next.id) } }} /> : isProjects ? <ProjectWorkspace projects={projects} loading={projectsLoading} error={!!projectError} projectId={projectId} team={section === 'team-projects' ? WORKSPACE_NAME : undefined} issues={tasks} userName={user.name || user.email} onSelect={setProjectId} onOpenTeam={() => { navigateSection('team-projects') }} onOpenIssue={open} onCreateIssue={() => create('todo')} onUpdated={() => { void refreshProjects() }} /> : isOverview ? <WorkspaceOverview section={section} counts={counts} projectCount={projects.length} tasks={tasks} userId={user.id} initialAgentHistory={initialAgentHistory} onOpen={id => open(id)} onProjects={() => navigateSection('team-projects')} onView={navigate} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold">{section === 'my-issues' ? t('myCreatedTasks') : viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge>{section !== 'my-issues' && <NativeSelect aria-label={t('filterStatus')} value={view} disabled={boardBusy} onChange={event => navigate(event.target.value as IssueView)}><NativeSelectOption value="all">{t('allStatuses')}</NativeSelectOption><NativeSelectOption value="favorites">{t('favorites')}</NativeSelectOption><NativeSelectOption value="following">{t('following')}</NativeSelectOption>{ISSUE_STATUSES.map(status => <NativeSelectOption key={status.value} value={status.value}>{statusLabel(status.value)}</NativeSelectOption>)}</NativeSelect>}</div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><div className="flex min-w-0 items-center gap-2 sm:w-48"><span className="inline-flex shrink-0 text-muted-foreground"><Search className="size-3.5" aria-hidden="true" /></span><Input aria-label={tNav('search')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /></div><ToggleGroup aria-label={t('taskView')} size="sm" variant="outline" spacing={0} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label={t('listView')}><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label={t('boardView')}><Columns3 /></ToggleGroupItem></ToggleGroup></div>
        </div>
        {layout === 'board' ? <IssueBoard issues={filtered} onOpen={open} onCreate={create} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={open} onCreate={() => create()} />}
      </>}
    </AppShellContent>
    </>}
    {creating && <CreateIssueDialog initialStatus={createStatus} open={creating} onOpenChange={setCreating} onCreated={id => { void issueCreated(id) }} author={user.name || user.email} />}
    {searchOpen && <IssueSearch open={searchOpen} onOpenChange={setSearchOpen} issues={tasks} onOpen={open} onCreate={() => create()} />}
  </AppShell>
}
