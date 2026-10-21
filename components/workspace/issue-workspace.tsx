'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useRouter, useSearchParams } from 'next/navigation'
import { Columns3, List, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IssueBoard } from './issue-board'
import { AppSidebar } from '@/components/app-sidebar'
import { TeamHome } from '@/components/teams/team-home'
import { AppShell, AppShellContent } from '@/components/app-shell'
import { CreateIssueDialog } from './create-issue-dialog'
import { IssueList } from './issue-list'
import { IssueSearch } from './issue-search'
import { ISSUE_STATUSES, issueIdentifier, type IssueStatus, type IssueView } from './issue-properties'
import { listIssues } from '@/app/actions/issues'
import { authClient } from '@/lib/auth-client'
import { TaskDetail } from './task-detail'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { listProjects, setProjectIssues } from '@/app/actions/projects'
import { listTeams } from '@/app/actions/teams'
import { listProjectTeams } from '@/app/actions/team-relations'
import { ProjectWorkspace } from './project-workspace'
import { WorkspaceOverview } from './workspace-overview'
import { SECTION_TITLES, type WorkspaceSection } from './workspace-navigation'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'

export function IssueWorkspace({ user, initialIssues, initialSelected = null }: { initialSelected?: string | null; user: { id: string; name: string; email: string; image?: string | null }; initialIssues?: Awaited<ReturnType<typeof listIssues>> }) {
  const params = useSearchParams()
  const { data: workspaceContext } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const { mutate: clearCache } = useSWRConfig()
  const [boardBusy, setBoardBusy] = useState(false)
  const { data: tasks = [], mutate, error } = useSWR('issues', listIssues, { fallbackData: initialIssues, refreshInterval: boardBusy ? 0 : 10000, revalidateOnFocus: !boardBusy, revalidateOnReconnect: !boardBusy })
  const { data: projects = [], error: projectError, isLoading: projectsLoading, mutate: refreshProjects } = useSWR(['projects', user.id], listProjects)
  const { data: teams = [] } = useSWR('teams', listTeams)
  const { data: projectTeams = [], mutate: refreshProjectTeams } = useSWR('project-teams', listProjectTeams)
  const [teamId, setTeamId] = useState<string | null>(params.get('team'))
  const activeTeam = teams.find(team => team.id === teamId)
  const [section, setSection] = useState<WorkspaceSection>(params.get('team') ? 'team-home' : 'projects')
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
      if (event.isComposing || event.keyCode === 229 || boardBusy) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault(); setSearchOpen(value => !value)
      } else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))) {
        event.preventDefault(); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreateStatus(ISSUE_STATUSES.some(status => status.value === view) ? view as IssueStatus : 'todo'); setCreating(true)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [creating, searchOpen, view, boardBusy, section, projectId])
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
    } catch { setAccountError('任务已创建，但项目关联失败。请在项目中手动关联已有任务。') }
  }
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        const result = await authClient.signOut()
        if (result.error) throw new Error('sign out failed')
        await clearCache(() => true, undefined, { revalidate: false }); router.replace('/sign-in?login=1'); router.refresh()
      } catch { setAccountError('退出失败，请稍后重试。'); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(null); if (['inbox', 'agent', 'views', 'team-home'].includes(section)) setSection('team-issues'); setView(next); setQuery(''); setDraftKey(value => value + 1) })
    return true
  }
  function navigateSection(next: WorkspaceSection) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(null); setSection(next); if (!next.startsWith('team-')) setTeamId(null); setProjectId(null); setView(next === 'my-issues' ? 'mine' : 'all'); setQuery(''); setDraftKey(value => value + 1) })
    return true
  }
  const isProjects = section === 'projects' || section === 'team-projects'
  const isOverview = ['inbox', 'agent', 'views', 'team-home'].includes(section)
  const scopedTasks = section.startsWith('team-') && teamId ? tasks.filter(task => task.teamId === teamId) : tasks
  const scopedProjects = section.startsWith('team-') && teamId ? projects.filter(project => projectTeams.some(link => link.projectId === project.id && link.teamId === teamId)) : projects
  const filtered = scopedTasks.filter(task => (view === 'all' || (view === 'mine' ? task.ownerId === user.id : view === 'shared' ? task.ownerId !== user.id : view === 'favorites' ? task.metadata.favoriteUserIds.includes(user.id) : view === 'following' ? task.metadata.subscriberUserIds.includes(user.id) : task.status === view)) && `${issueIdentifier(task.metadata.number)} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()))
  const counts: Record<IssueView, number> = { all: scopedTasks.length, mine: 0, shared: 0, favorites: 0, following: 0, backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0, duplicate: 0 }
  for (const task of scopedTasks) {
    if (ISSUE_STATUSES.some(status => status.value === task.status)) counts[task.status as IssueStatus]++
    counts[task.ownerId === user.id ? 'mine' : 'shared']++
    if (task.metadata.favoriteUserIds.includes(user.id)) counts.favorites++
    if (task.metadata.subscriberUserIds.includes(user.id)) counts.following++
  }
  const viewTitle = view === 'all' ? '全部任务' : view === 'mine' ? '我创建的' : view === 'shared' ? '协作任务' : view === 'favorites' ? '收藏的任务' : view === 'following' ? '关注的任务' : ISSUE_STATUSES.find(status => status.value === view)?.label ?? '全部任务'
  return <AppShell fixed={!selected && !isProjects && !isOverview && layout === 'board'}>
    <AppSidebar onBeforeChange={action => { if (!boardBusy && !leaving.current) void leave(action) }} onSettings={(href = '/settings') => { if (!boardBusy && !leaving.current) void leave(() => { pushSettingsHistory(href) }) }} user={user} section={section} teamId={teamId} onTeamNavigate={(id, next) => { if (boardBusy || leaving.current) return false; void leave(() => { setTeamId(id); setSelected(null); setSection(next); setProjectId(null); setView('all'); setQuery('') }); return true }} onNavigate={navigateSection} onSearch={() => { if (!boardBusy) setSearchOpen(true) }} onCreate={() => create()} onSignOut={signOut} signingOut={signingOut} />
    <AppShellContent hideHeader={!!selected} parent={section.startsWith('team-') && activeTeam ? activeTeam.name : workspaceContext?.workspace.name ?? '工作区'} title={SECTION_TITLES[section]} actions={<Button variant="ghost" size="icon-sm" aria-label="打开全局搜索" disabled={boardBusy} onClick={() => setSearchOpen(true)}><Search data-icon="inline-start" /></Button>}>
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {error && <p role="alert" className="px-6 py-2 text-xs text-destructive">列表更新失败，已保留上次结果。</p>}
      {selected ? <TaskDetail key={draftKey} id={selected} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} onDeleted={deleted} onOpen={id => open(id)} navigation={{ index: filtered.findIndex(task => task.id === selected), total: filtered.length, onOpen: offset => { const index = filtered.findIndex(task => task.id === selected); const next = filtered[index + offset]; if (index >= 0 && next) open(next.id) } }} /> : isProjects ? <ProjectWorkspace projects={scopedProjects} loading={projectsLoading} error={!!projectError} projectId={projectId} team={section === 'team-projects' ? activeTeam?.name : undefined} initialTeamId={section === 'team-projects' ? teamId ?? undefined : undefined} issues={tasks} userName={user.name || user.email} onSelect={setProjectId} onOpenTeam={() => { navigateSection('team-projects') }} onOpenIssue={open} onCreateIssue={() => create('todo')} onUpdated={() => { void refreshProjects(); void refreshProjectTeams() }} /> : section === 'team-home' && activeTeam ? <TeamHome key={activeTeam.id} team={activeTeam} projects={scopedProjects} issueCount={counts.all} onIssues={() => navigate('all')} onProjects={() => navigateSection('team-projects')} onProject={id => { void leave(() => { setSection('team-projects'); setProjectId(id); setSelected(null) }) }} /> : isOverview ? <WorkspaceOverview section={section} teamName={activeTeam?.name} counts={counts} projectCount={scopedProjects.length} tasks={scopedTasks} userId={user.id} onOpen={id => open(id)} onProjects={() => navigateSection('team-projects')} onView={navigate} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold">{section === 'my-issues' ? '我创建的任务' : viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge>{section !== 'my-issues' && <NativeSelect aria-label="筛选任务状态" value={view} disabled={boardBusy} onChange={event => navigate(event.target.value as IssueView)}><NativeSelectOption value="all">全部状态</NativeSelectOption><NativeSelectOption value="favorites">收藏的任务</NativeSelectOption><NativeSelectOption value="following">关注的任务</NativeSelectOption>{ISSUE_STATUSES.map(status => <NativeSelectOption key={status.value} value={status.value}>{status.label}</NativeSelectOption>)}</NativeSelect>}</div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><div className="flex min-w-0 items-center gap-2 sm:w-48"><span className="inline-flex shrink-0 text-muted-foreground"><Search className="size-3.5" aria-hidden="true" /></span><Input aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /></div><ToggleGroup aria-label="任务视图" size="sm" variant="outline" spacing={0} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label="列表视图"><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label="看板视图"><Columns3 /></ToggleGroupItem></ToggleGroup></div>
        </div>
        {layout === 'board' ? <IssueBoard issues={filtered} onOpen={open} onCreate={create} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={open} onCreate={() => create()} />}
      </>}
    </AppShellContent>
    {creating && <CreateIssueDialog initialTeamId={(creationProject ? projectTeams.find(link => link.projectId === creationProject && link.isPrimary)?.teamId : section.startsWith('team-') ? teamId : null) ?? ''} initialStatus={createStatus} open={creating} onOpenChange={setCreating} onCreated={id => { void issueCreated(id) }} author={user.name || user.email} />}
    {searchOpen && <IssueSearch open={searchOpen} onOpenChange={setSearchOpen} issues={tasks} onOpen={open} onCreate={() => create()} />}
  </AppShell>
}
