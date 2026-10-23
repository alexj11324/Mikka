'use client'
import { useTranslations } from 'next-intl'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { Columns3, List, Plus, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IssueBoard } from './issue-board'
import { IconRail, type RailDestination } from '@/components/nav/icon-rail'
import { ConversationList, type Conversation } from '@/components/nav/conversation-list'
import type { AgentSessionRequest } from './agent-panel'
import { TeamHome } from '@/components/teams/team-home'
import { AppShell, AppShellContent, SignOutBoundary } from '@/components/app-shell'
import { IssueList } from './issue-list'
import { IssueSearch } from './issue-search'
import { ISSUE_STATUSES, issueIdentifier, type IssueStatus, type IssueView } from './issue-properties'
import { listIssues } from '@/app/actions/issues'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { listProjects, setProjectIssues } from '@/app/actions/projects'
import { listTeams } from '@/app/actions/teams'
import { listProjectTeams } from '@/app/actions/team-relations'
import { WorkspaceOverview } from './workspace-overview'
import { PluginsSkillsView } from '@/components/plugins/plugins-skills-view'
import type { WorkspaceSection } from './workspace-navigation'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { bufferTypeAhead, typingOrDialog } from '@/lib/shortcut-guard'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import type { AgentHistory } from '@/lib/agent-history'
import { useAgentHistory } from '@/hooks/use-agent-history'
import { useWorkspace } from '@/hooks/use-workspace'

// Start the chunk download during module evaluation, before hydration and its effects.
if (typeof window !== 'undefined') {
  void import('./agent-panel').catch(() => {})
  void import('./create-issue-dialog').catch(() => {})
}

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
const ProjectWorkspace = dynamic(() => import('./project-workspace').then(module => module.ProjectWorkspace), { loading: DetailLoading })
const SettingsShell = dynamic(() => import('@/components/settings/settings-shell').then(module => module.SettingsShell))
const SettingsView = dynamic(() => import('@/components/settings/settings-view').then(module => module.SettingsView))

export function IssueWorkspace({ user, initialIssues, initialSelected = null, initialAgentHistory, initialSection = 'coordinator', initialSettingsSection, googleEnabled = false }: { initialSelected?: string | null; user: { id: string; name: string; email: string; image?: string | null }; initialIssues?: Awaited<ReturnType<typeof listIssues>>; initialAgentHistory?: AgentHistory; initialSection?: WorkspaceSection; initialSettingsSection?: 'integrations'; googleEnabled?: boolean }) {
  const i18nText = useTranslations()
  const { data: workspaceData } = useWorkspace(user.email)
  const { data: agentHistory } = useAgentHistory(user.id, initialAgentHistory)
  const t = useTranslations('Workspace')
  const tIssue = useTranslations('Issue')
  const tPlugins = useTranslations('Plugins')
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const { data: workspaceContext } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const { mutate: clearCache } = useSWRConfig()
  const sectionTitles: Record<WorkspaceSection, string> = {
    inbox: i18nText('Overview.sections.inbox'),
    'my-issues': i18nText('Overview.sections.myIssues'),
    agent: i18nText('Overview.sections.agent'),
    coordinator: i18nText('Overview.sections.coordinator'),
    projects: i18nText('Overview.sections.projects'),
    views: i18nText('Overview.sections.views'),
    'team-home': i18nText('Overview.sections.teamHome'),
    'team-issues': i18nText('Overview.sections.teamIssues'),
    'team-projects': i18nText('Overview.sections.teamProjects'),
    'all-issues': i18nText('Overview.sections.allIssues'),
    plugins: tPlugins('title'),
  }
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsSection === 'integrations')
  const [settingsTarget, setSettingsTarget] = useState<{ section: 'preferences' | 'members' | 'integrations'; invite: boolean }>({ section: initialSettingsSection ?? 'preferences', invite: false })
  const [linearNotice, setLinearNotice] = useState<'connected' | 'error' | null>(null)
  useEffect(() => {
    const url = new URL(window.location.href)
    const result = url.searchParams.get('linear')
    if (result !== 'connected' && result !== 'error') return
    setSettingsOpen(true)
    setSettingsTarget({ section: 'integrations', invite: false })
    setLinearNotice(result)
    url.searchParams.delete('linear')
    window.history.replaceState(null, '', url)
  }, [])
  const [boardBusy, setBoardBusy] = useState(false)
  const { data: tasks = [], mutate, error, isLoading: tasksLoading } = useSWR(['issues', user.id], listIssues, { fallbackData: initialIssues, revalidateOnMount: initialIssues === undefined, refreshInterval: boardBusy ? 0 : 10000, revalidateOnFocus: !boardBusy, revalidateOnReconnect: !boardBusy })
  // Keep failed refreshes out of document flow so the board/list never jumps.
  const listErrorMessage = t('listError')
  useEffect(() => {
    const id = `issue-list-error-${user.id}`
    if (error) toast.error(listErrorMessage, { id, duration: Infinity })
    else toast.dismiss(id)
    return () => { toast.dismiss(id) }
  }, [error, listErrorMessage, user.id])
  const { data: projects = [], error: projectError, isLoading: projectsLoading, mutate: refreshProjects } = useSWR(['projects', user.id], listProjects)
  const { data: teams = [] } = useSWR('teams', listTeams)
  const { data: projectTeams = [], mutate: refreshProjectTeams } = useSWR('project-teams', listProjectTeams)
  const [teamId, setTeamId] = useState<string | null>(params.get('team'))
  const activeTeam = teams.find(team => team.id === teamId)
  const [section, setSection] = useState<WorkspaceSection>(params.get('team') ? 'team-home' : initialSection)
  function changeSection(next: WorkspaceSection) {
    setSection(next)
    const url = new URL(window.location.href)
    if (next === 'agent' || next === 'coordinator') url.searchParams.set('section', next)
    else url.searchParams.delete('section')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const [agentRequest, setAgentRequest] = useState<AgentSessionRequest>()
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const lastConversation = useRef<Conversation>(initialSection === 'agent' ? { kind: 'agent', sessionId: null } : { kind: 'coordinator' })
  const [projectId, setProjectId] = useState<string | null>(null)
  const [creationProject, setCreationProject] = useState<string | null>(null)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo')
  const [selected, setSelected] = useState<string | null>(initialSelected)
  const [pendingSelection, setPendingSelection] = useState<string | null | undefined>(undefined)
  const selectedRef = useRef(selected)
  const [draftKey, setDraftKey] = useState(0)
  const dirtyRef = useRef(false)
  const flushDetail = useRef<(() => Promise<boolean>) | null>(null)
  const leaving = useRef(false)
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => { flushDetail.current = flush }, [])
  function issueLocation(id: string | null) {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set('issue', id)
    else url.searchParams.delete('issue')
    return `${url.pathname}${url.search}${url.hash}`
  }
  function readIssueParam() {
    const value = new URL(window.location.href).searchParams.get('issue')
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null
  }
  function applySelection(id: string | null, mode: 'push' | 'replace' | 'skip') {
    selectedRef.current = id
    setSelected(id)
    setDraftKey(value => value + 1)
    if (mode === 'skip') return
    const url = issueLocation(id)
    if (mode === 'push') window.history.pushState(window.history.state, '', url)
    else window.history.replaceState(window.history.state, '', url)
  }
  const [query, setQuery] = useState('')
  const [view, setView] = useState<IssueView>('all')
  const [creating, setCreating] = useState(false)
  const [typedAhead, setTypedAhead] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || boardBusy || settingsOpen || leaving.current) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault(); setSearchOpen(value => !value)
      } else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !typingOrDialog(event.target)) {
        event.preventDefault(); setTypedAhead(''); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreateStatus(ISSUE_STATUSES.some(status => status.value === view) ? view as IssueStatus : 'todo'); setCreating(true)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [creating, searchOpen, view, boardBusy, section, projectId])
  useEffect(() => {
    if (!creating) return
    function capture(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return
      const titleField = document.getElementById('new-issue-title')
      const dialog = titleField?.closest('[role="dialog"], [role="alertdialog"]')
      const dialogReady = !!dialog && (document.activeElement === titleField || dialog.contains(document.activeElement))
      if (bufferTypeAhead('', event.key, dialogReady) === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setTypedAhead(current => bufferTypeAhead(current, event.key, false) ?? current)
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [creating])
  const [signingOut, setSigningOut] = useState(false)
  const [accountError, setAccountError] = useState('')
  const onDirty = useCallback((value: boolean) => { dirtyRef.current = value }, [])
  async function leave(action: () => void | Promise<void>) {
    leaving.current = true
    try {
      if (flushDetail.current) {
        if (!await flushDetail.current()) return false
      } else if (dirtyRef.current) return false
      dirtyRef.current = false
      await action()
      return true
    } finally { leaving.current = false }
  }
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => {
    function onPop() {
      const next = readIssueParam()
      const previous = selectedRef.current
      if (next === previous) return
      void (async () => {
        const ok = await leaveRef.current(() => { applySelection(next, 'skip') })
        if (!ok) window.history.replaceState(window.history.state, '', issueLocation(previous))
      })()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  function closeSettings() {
    setSettingsOpen(false)
    const url = new URL(window.location.href)
    if (!url.searchParams.has('settings')) return
    url.searchParams.delete('settings')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  function showIssue(id: string | null, mode: 'push' | 'replace' = 'push') {
    applySelection(id, mode)
  }
  function open(id: string | null) {
    if (boardBusy || leaving.current) return false
    setPendingSelection(id)
    void leave(() => showIssue(id, 'push')).finally(() => setPendingSelection(undefined))
    return true
  }
  function deleted() {
    flushDetail.current = null
    dirtyRef.current = false
    showIssue(null, 'replace')
  }
  const saved = useCallback((id: string) => { setSelected(id); void mutate() }, [mutate])
  function create(status: IssueStatus = ISSUE_STATUSES.some(item => item.value === view) ? view as IssueStatus : 'todo') { if (boardBusy) return; setTypedAhead(''); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreateStatus(status); setCreating(true) }
  async function issueCreated(id: string) {
    void mutate()
    if (!creationProject) return
    try {
      const latest = (await listProjects()).find(project => project.id === creationProject)
      if (!latest) throw new Error('project missing')
      const result = await setProjectIssues({ id: latest.id, revision: latest.revision, issueIds: [...latest.issueIds, id] })
      if (result.error) throw new Error(result.error)
      await refreshProjects()
    } catch { setAccountError(i18nText("Workspace.projectLinkFailed")) }
  }
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        const result = await authClient.signOut()
        if (result.error) throw new Error('sign out failed')
        await clearCache(() => true, undefined, { revalidate: false }); router.replace('/sign-in?login=1'); router.refresh()
      } catch { setAccountError(i18nText("Workspace.signOutFailed")); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    void leave(() => { applySelection(null, 'replace'); if (['inbox', 'agent', 'coordinator', 'views', 'team-home'].includes(section)) changeSection('team-issues'); setView(next); setQuery('') })
    return true
  }
  function navigateSection(next: WorkspaceSection) {
    if (boardBusy || leaving.current) return false
    void leave(() => { applySelection(null, 'replace'); changeSection(next); if (!next.startsWith('team-')) setTeamId(null); setProjectId(null); setView(next === 'my-issues' ? 'mine' : 'all'); setQuery('') })
    return true
  }
  function openConversation(conversation: Conversation) {
    if (boardBusy || leaving.current) return
    void leave(() => {
      lastConversation.current = conversation
      applySelection(null, 'replace'); changeSection(conversation.kind); setTeamId(null); setProjectId(null)
      if (conversation.kind === 'agent') setAgentRequest(current => ({ sessionId: conversation.sessionId, nonce: (current?.nonce ?? 0) + 1 }))
    })
  }
  function openRail(destination: RailDestination) {
    if (destination === 'conversations') {
      // Coming back from the board reopens the conversation that was showing, not a fresh one.
      const last = lastConversation.current
      openConversation(last.kind === 'agent' ? { kind: 'agent', sessionId: activeAgentId ?? last.sessionId } : last)
    } else if (destination === 'board') { if (navigateSection('all-issues')) setLayout('board') }
    else navigateSection('plugins')
  }
  const rail: RailDestination | null = section === 'coordinator' || section === 'agent' ? 'conversations' : section === 'plugins' ? 'plugins' : ['all-issues', 'my-issues', 'team-issues'].includes(section) ? 'board' : null
  const activeConversation: Conversation | null = section === 'coordinator' ? { kind: 'coordinator' } : section === 'agent' ? { kind: 'agent', sessionId: activeAgentId } : null
  const beforeChange = (action: () => Promise<void>) => { if (!boardBusy && !leaving.current) void leave(action) }
  const openSettings = (href = '/settings') => { if (!boardBusy && !leaving.current) void leave(() => { if (!pushSettingsHistory(href)) router.push(href) }) }
  const isProjects = section === 'projects' || section === 'team-projects'
  const isOverview = ['inbox', 'agent', 'coordinator', 'views', 'team-home'].includes(section)
  const scopedTasks = section.startsWith('team-') && teamId ? tasks.filter(task => task.teamId === teamId) : tasks
  const scopedProjects = section.startsWith('team-') && teamId ? projects.filter(project => projectTeams.some(link => link.projectId === project.id && link.teamId === teamId)) : projects
  const filtered = scopedTasks.filter(task => (view === 'all' || (view === 'mine' ? task.ownerId === user.id : view === 'shared' ? task.ownerId !== user.id : view === 'favorites' ? task.metadata.favoriteUserIds.includes(user.id) : view === 'following' ? task.metadata.subscriberUserIds.includes(user.id) : task.status === view)) && `${issueIdentifier(task, i18nText("Issue.unassignedNumber"))} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()))
  const counts: Record<IssueView, number> = { all: scopedTasks.length, mine: 0, shared: 0, favorites: 0, following: 0, backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0, duplicate: 0 }
  for (const task of scopedTasks) {
    if (ISSUE_STATUSES.some(status => status.value === task.status)) counts[task.status as IssueStatus]++
    counts[task.ownerId === user.id ? 'mine' : 'shared']++
    if (task.metadata.favoriteUserIds.includes(user.id)) counts.favorites++
    if (task.metadata.subscriberUserIds.includes(user.id)) counts.following++
  }
  const viewTitle = view === 'all' ? t('allIssues') : view === 'mine' ? t('mine') : view === 'shared' ? t('shared') : view === 'favorites' ? t('favorites') : view === 'following' ? t('following') : statusLabel(view)
  const pagerId = pendingSelection !== undefined ? pendingSelection : selected
  const pagerIndex = pagerId ? filtered.findIndex(task => task.id === pagerId) : -1
  if (pathname.startsWith('/settings')) return <SettingsShell user={user} defaultWorkspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} googleEnabled={googleEnabled} onBack={() => { const href = teamId ? `/?team=${encodeURIComponent(teamId)}` : '/'; if (!pushSettingsHistory(href)) router.push(href) }} />
  return <SignOutBoundary pending={signingOut}><AppShell fixed={!settingsOpen && !selected && (!isProjects && ((!isOverview && layout === 'board') || section === 'coordinator' || section === 'agent'))}>
    {settingsOpen ? <SettingsView initialSection={settingsTarget.section} linearNotice={linearNotice} inviteInitially={settingsTarget.invite} user={user} googleEnabled={googleEnabled} onBack={closeSettings} onSignOut={signOut} signingOut={signingOut} accountError={accountError} /> : <>
    <IconRail active={rail} onNavigate={openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={beforeChange} />
    <ConversationList sessions={agentHistory?.sessions ?? []} active={activeConversation} onOpen={openConversation} rail={rail} onRail={openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={beforeChange} />
    <AppShellContent hideHeader={!!selected || section === 'agent'} parent={section.startsWith('team-') && activeTeam ? activeTeam.name : workspaceContext?.workspace.name ?? i18nText("Settings.sections.workspace.title")} title={sectionTitles[section]} actions={section === 'plugins' ? undefined : <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText("Workspace.openSearch")} aria-keyshortcuts="Control+k Meta+k" disabled={boardBusy} onClick={() => setSearchOpen(true)} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText("Workspace.search.title")}<ShortcutKeys keys={['mod', 'K']} /></TooltipContent></Tooltip>}>
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {selected ? <TaskDetail key={draftKey} id={selected} workspaceName={workspaceContext?.workspace.name ?? i18nText('Settings.sections.workspace.title')} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} onDeleted={deleted} onOpen={id => open(id)} navigation={{ index: pagerIndex, total: filtered.length, onOpen: offset => { const index = filtered.findIndex(task => task.id === selected); const next = filtered[index + offset]; if (index >= 0 && next) open(next.id) } }} /> : isProjects ? <ProjectWorkspace projects={scopedProjects} loading={projectsLoading} error={!!projectError} projectId={projectId} team={section === 'team-projects' ? activeTeam?.name : undefined} initialTeamId={section === 'team-projects' ? teamId ?? undefined : undefined} issues={tasks} userName={user.name || user.email} onSelect={setProjectId} onOpenTeam={() => { navigateSection('team-projects') }} onOpenIssue={open} onCreateIssue={() => create('todo')} onUpdated={() => { void refreshProjects(); void refreshProjectTeams() }} /> : section === 'team-home' && activeTeam ? <TeamHome key={activeTeam.id} team={activeTeam} projects={scopedProjects} issueCount={counts.all} onIssues={() => navigate('all')} onProjects={() => navigateSection('team-projects')} onProject={id => { void leave(() => { applySelection(null, 'replace'); changeSection('team-projects'); setProjectId(id) }) }} /> : isOverview ? <WorkspaceOverview section={section} teamName={activeTeam?.name} counts={counts} projectCount={scopedProjects.length} tasks={scopedTasks} userId={user.id} initialAgentHistory={initialAgentHistory} agentRequest={agentRequest} onAgentActive={setActiveAgentId} onOpen={id => open(id)} onProjects={() => navigateSection('team-projects')} onView={navigate} /> : section === 'plugins' ? <PluginsSkillsView googleEnabled={googleEnabled} /> : tasksLoading ? <DetailLoading /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold">{section === 'my-issues' ? i18nText("Workspace.myCreatedTasks") : viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge>{section !== 'my-issues' && <NativeSelect aria-label={i18nText("Workspace.filterStatus")} value={view} disabled={boardBusy} onChange={event => navigate(event.target.value as IssueView)}><NativeSelectOption value="all">{i18nText("Projects.allStatuses")}</NativeSelectOption><NativeSelectOption value="favorites">{i18nText("Overview.favorites")}</NativeSelectOption><NativeSelectOption value="following">{i18nText("Overview.following")}</NativeSelectOption>{ISSUE_STATUSES.map(status => <NativeSelectOption key={status.value} value={status.value}>{statusLabel(status.value)}</NativeSelectOption>)}</NativeSelect>}</div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><div className="flex min-w-0 items-center gap-2 sm:w-48"><span className="inline-flex shrink-0 text-muted-foreground"><Search className="size-3.5" aria-hidden="true" /></span><Input aria-label={i18nText("Workspace.search.title")} placeholder={i18nText("Projects.issuePicker.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /></div><ToggleGroup aria-label={i18nText("Workspace.taskView")} size="sm" variant="outline" spacing={0} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label={i18nText("Workspace.listView")}><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label={i18nText("Workspace.boardView")}><Columns3 /></ToggleGroupItem></ToggleGroup><Button size="sm" disabled={boardBusy} onClick={() => create()}><Plus data-icon="inline-start" />{i18nText("Nav.newTask")}</Button></div>
        </div>
        {layout === 'board' ? <IssueBoard issues={filtered} onOpen={open} onCreate={create} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={open} onCreate={() => create()} />}
      </>}
    </AppShellContent>
    </>}
    {creating && <CreateIssueDialog initialTitle={typedAhead} initialTeamId={(creationProject ? projectTeams.find(link => link.projectId === creationProject && link.isPrimary)?.teamId : section.startsWith('team-') ? teamId : null) ?? ''} initialStatus={createStatus} open={creating} onOpenChange={open => { setCreating(open); if (!open) setTypedAhead('') }} onCreated={id => { void issueCreated(id) }} author={user.name || user.email} />}
    {searchOpen && <IssueSearch open={searchOpen} onOpenChange={setSearchOpen} issues={tasks} onOpen={open} onCreate={() => create()} />}
  </AppShell></SignOutBoundary>
}
