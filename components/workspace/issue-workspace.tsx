'use client'
import { useTranslations } from 'next-intl'
import { AnimatePresence } from 'motion/react'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { Columns3, List, Plus, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IconRail, type RailDestination } from '@/components/nav/icon-rail'
import { BotList, type ChatTarget } from '@/components/nav/bot-list'
import { NewBotDialog } from '@/components/nav/new-bot-dialog'
import { Onboarding, type E2BKeyResult, type OnboardingComputer } from '@/components/onboarding/onboarding'
import type { LegacyChatRequest } from './legacy-chat-archive'
import { TeamHome } from '@/components/teams/team-home'
import { AppFrame, AppShellContent, SignOutBoundary, WindowBar } from '@/components/app-shell'
import { IssueList } from './issue-list'
import { BoardPage } from './board-page'
import { NewTaskDialog } from '@/components/coordinator/new-task-dialog'
import { GlobalSearch, SearchPill } from '@/components/nav/global-search'
import { ContextPanel } from '@/components/nav/context-panel'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { BrowserPane } from '@/components/browser/browser-pane'
import { BrowserNotesProvider } from '@/components/browser/browser-notes'
import { BrowserToggle, useBrowserFits } from '@/components/browser/browser-toggle'
import { ComputerAgentsProvider } from '@/components/computer/computer-agents'
import { listThreads } from '@/app/actions/task-runs'
import { listBots, type BotView } from '@/app/actions/bots'
import { getCoordinatorChat, type CoordinatorChat as CoordinatorChatView } from '@/app/actions/coordinator'
import { chatPreview } from '@/lib/agent-history'
import { PanelRight } from 'lucide-react'
import { ISSUE_STATUSES, issueIdentifier, type IssueStatus, type IssueView } from './issue-properties'
import { listIssues } from '@/app/actions/issues'
import { endSession } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Badge } from '@/components/ui/badge'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SearchInput } from '@/components/ui/search-input'
import { listProjects } from '@/app/actions/projects'
import { saveE2BKey } from '@/app/actions/workspace-secrets'
import { listTeams } from '@/app/actions/teams'
import { listProjectTeams } from '@/app/actions/team-relations'
import { WorkspaceOverview } from './workspace-overview'
import { GroupChatView, type GroupChatRequest } from './group-chat-view'
import { WorkspaceContentLoading, WorkspaceLoading } from './workspace-loading'
import { PluginsPage } from '@/components/plugins/plugins-view'
import { SuggestionFeed } from '@/components/suggestions/suggestion-feed'
import { ArtifactLibrary } from '@/components/artifacts/artifact-library'
import { writeSectionQuery, type WorkspaceSection } from './workspace-navigation'
import { pushSettingsHistory, requestShellSearch, takeShellSearchRequest } from '@/lib/settings-navigation'
import { resolveSettingsSection, type SettingsSectionId } from '@/lib/settings-sections'
import { bufferTypeAhead, typingOrDialog } from '@/lib/shortcut-guard'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import type { AgentHistory, SavedAgentSession } from '@/lib/agent-history'
import { useAgentHistory } from '@/hooks/use-agent-history'
import { useWorkspace } from '@/hooks/use-workspace'
import { usePresence } from '@/lib/use-presence'
import { FieldError } from '@/components/ui/field'

// Start the chunk download during module evaluation, before hydration and its effects.
if (typeof window !== 'undefined') {
  void import('./legacy-chat-archive').catch(() => {})
  void import('./create-issue-dialog').catch(() => {})
}

/** The guide's E2B step saves the workspace key; only a rejected key reads as invalid. */
async function saveOnboardingKey(apiKey: string): Promise<E2BKeyResult> {
  const result = await saveE2BKey({ apiKey })
  return !result.error ? 'ok' : result.error === 'e2bKeyInvalid' ? 'invalid' : 'unavailable'
}

function DetailLoading() {
  const t = useTranslations('Workspace')
  return <div role="status" aria-label={t('loadingEditor')} className="flex flex-col gap-6 p-8"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-40 w-full" /></div>
}
const TaskDetail = dynamic(() => import('./task-detail').then(module => module.TaskDetail), { loading: DetailLoading })
const ProjectWorkspace = dynamic(() => import('./project-workspace').then(module => module.ProjectWorkspace), { loading: DetailLoading })
// Settings open through history.pushState; without their own fallback a first chunk load suspends
// up to the route's loading boundary, which can stay stuck on the skeleton.
const SettingsShell = dynamic(() => import('@/components/settings/settings-shell').then(module => module.SettingsShell), { loading: WorkspaceLoading })
const SettingsFrame = dynamic(() => import('@/components/settings/settings-shell').then(module => module.SettingsFrame), { loading: WorkspaceLoading })
const SettingsView = dynamic(() => import('@/components/settings/settings-view').then(module => module.SettingsView), { loading: WorkspaceContentLoading })

export function IssueWorkspace({ user, initialIssues, initialSelected = null, initialAgentHistory, initialSection = 'coordinator', initialSettingsSection, googleEnabled = false, onboarding }: { onboarding?: { computer: OnboardingComputer }; initialSelected?: string | null; user: { id: string; name: string; email: string; image?: string | null }; initialIssues?: Awaited<ReturnType<typeof listIssues>>; initialAgentHistory?: AgentHistory; initialSection?: WorkspaceSection; initialSettingsSection?: 'integrations' | 'account'; googleEnabled?: boolean }) {
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
  // The group chat opened from search; group chats have no list or URL of their own yet.
  const [groupRequest, setGroupRequest] = useState<GroupChatRequest | null>(null)
  const sectionTitles: Record<WorkspaceSection, string> = {
    inbox: i18nText('Overview.sections.inbox'),
    'my-issues': i18nText('Overview.sections.myIssues'),
    agent: i18nText('Overview.sections.agent'),
    coordinator: i18nText('Overview.sections.coordinator'),
    group: groupRequest?.title || i18nText('GroupChat.untitled'),
    projects: i18nText('Overview.sections.projects'),
    views: i18nText('Overview.sections.views'),
    'team-home': i18nText('Overview.sections.teamHome'),
    'team-issues': i18nText('Overview.sections.teamIssues'),
    'team-projects': i18nText('Overview.sections.teamProjects'),
    'all-issues': i18nText('Overview.sections.allIssues'),
    plugins: tPlugins('title'),
    suggestions: i18nText('Nav.suggestions'),
    artifacts: i18nText('Nav.artifacts'),
  }
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsSection))
  // While Settings is shown these reads are not on screen. Paused, they cannot queue
  // server actions ahead of a settings save (Next runs a page's actions one at a time).
  const settingsShown = settingsOpen || pathname.startsWith('/settings')
  const inSettings = useRef(settingsShown)
  inSettings.current = settingsShown
  const whileSettings = { isPaused: () => inSettings.current }
  const [settingsTarget, setSettingsTarget] = useState<{ section: SettingsSectionId; invite: boolean }>({ section: initialSettingsSection ? resolveSettingsSection('/settings', initialSettingsSection) : 'preferences', invite: false })
  const [linearNotice, setLinearNotice] = useState<'connected' | 'error' | null>(null)
  useEffect(() => {
    const url = new URL(window.location.href)
    const result = url.searchParams.get('linear')
    if (result !== 'connected' && result !== 'error') return
    setSettingsOpen(true)
    setSettingsTarget({ section: 'connections', invite: false })
    setLinearNotice(result)
    url.searchParams.delete('linear')
    window.history.replaceState(null, '', url)
  }, [])
  const [boardBusy, setBoardBusy] = useState(false)
  const { data: tasks = [], mutate, error, isLoading: tasksLoading } = useSWR(['issues', user.id], listIssues, { ...whileSettings, fallbackData: initialIssues, revalidateOnMount: initialIssues === undefined, refreshInterval: boardBusy || settingsShown ? 0 : 10000, revalidateOnFocus: !boardBusy, revalidateOnReconnect: !boardBusy })
  // Keep failed refreshes out of document flow so the board/list never jumps.
  const listErrorMessage = t('listError')
  useEffect(() => {
    const id = `issue-list-error-${user.id}`
    if (error) toast.error(listErrorMessage, { id, duration: Infinity })
    else toast.dismiss(id)
    return () => { toast.dismiss(id) }
  }, [error, listErrorMessage, user.id])
  const { data: projects = [], error: projectError, isLoading: projectsLoading, mutate: refreshProjects } = useSWR(['projects', user.id], listProjects, whileSettings)
  const { data: teams = [] } = useSWR('teams', listTeams, whileSettings)
  const { data: projectTeams = [], mutate: refreshProjectTeams } = useSWR('project-teams', listProjectTeams, whileSettings)
  const { data: bots = [] } = useSWR('bots', listBots, { ...whileSettings })
  const [onboardingOpen, setOnboardingOpen] = useState(Boolean(onboarding))
  const { data: threads = [], mutate: refreshThreads } = useSWR('threads', () => listThreads(), { ...whileSettings, refreshInterval: boardBusy || settingsShown ? 0 : 15000 })
  const settingsWereShown = useRef(settingsShown)
  useEffect(() => {
    if (settingsWereShown.current && !settingsShown) {
      void mutate()
      void refreshThreads()
    }
    settingsWereShown.current = settingsShown
  }, [settingsShown, mutate, refreshThreads])
  const [creatingBot, setCreatingBot] = useState(false)
  const [createdBot, setCreatedBot] = useState<BotView>()
  const { data: coordinatorChat } = useSWR<CoordinatorChatView>('coordinator-chat', () => getCoordinatorChat(), { ...whileSettings })
  const [panelOpen, setPanelOpen] = useState(true)
  useEffect(() => { try { if (window.localStorage.getItem('mikka:context-panel') === '0') setPanelOpen(false) } catch { /* storage unavailable */ } }, [])
  // Below xl the column has no room, so 打开右栏 shows it in a Sheet instead.
  const [panelSheet, setPanelSheet] = useState(false)
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 80rem)')
    const close = () => { if (wide.matches) setPanelSheet(false) }
    wide.addEventListener('change', close)
    return () => wide.removeEventListener('change', close)
  }, [])
  function openPanel() { showPanel(true); if (!window.matchMedia('(min-width: 80rem)').matches) setPanelSheet(true) }
  function showPanel(next: boolean) { setPanelOpen(next); try { window.localStorage.setItem('mikka:context-panel', next ? '1' : '0') } catch { /* storage unavailable */ } }
  // The app-wide browser (top bar 🌐): while open it takes the right panel's place.
  const [browserOpen, setBrowserOpen] = useState(false)
  // Not inside a frame: the app opened in its own browser must not open another one.
  useEffect(() => { try { if (window.self === window.top && window.localStorage.getItem('mikka:browser') === '1') setBrowserOpen(true) } catch { /* storage unavailable */ } }, [])
  // Below lg the toggle is hidden, so the browser counts as closed and the right panel stays.
  const browserFits = useBrowserFits()
  const browserShown = browserOpen && browserFits
  function showBrowser(next: boolean) { setBrowserOpen(next); try { window.localStorage.setItem('mikka:browser', next ? '1' : '0') } catch { /* storage unavailable */ } }
  const [teamId, setTeamId] = useState<string | null>(params.get('team'))
  const activeTeam = teams.find(team => team.id === teamId)
  const [section, setSection] = useState<WorkspaceSection>(params.get('team') ? 'team-home' : initialSection)
  const [pluginsVisit, setPluginsVisit] = useState(0)
  // True only while the detail was loaded directly and no section has been chosen since.
  const directDetail = useRef(initialSelected !== null)
  function changeSection(next: WorkspaceSection, botId: string | null = null) {
    directDetail.current = false
    setSection(next)
    const url = new URL(window.location.href)
    writeSectionQuery(url.searchParams, next)
    // An app's page (?app=) belongs to the plugins page; choosing a section opens its top.
    url.searchParams.delete('app')
    if (next === 'plugins') setPluginsVisit(visit => visit + 1)
    if (next === 'coordinator' && botId) url.searchParams.set('bot', botId)
    else url.searchParams.delete('bot')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const [agentRequest, setAgentRequest] = useState<LegacyChatRequest>()
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  // The bot whose chat is in the center; null for the Coordinator. Every bot chat runs on the Coordinator harness.
  const [activeBotId, setActiveBotId] = useState<string | null>(initialSection === 'coordinator' ? params.get('bot') : null)
  // Historical chat records are read-only.
  const [liveSessions, setLiveSessions] = useState<SavedAgentSession[]>([])
  const lastChat = useRef<ChatTarget>(initialSection === 'agent' ? { kind: 'agent', sessionId: null } : params.get('bot') ? { kind: 'bot', botId: params.get('bot')! } : { kind: 'coordinator' })
  const [projectId, setProjectId] = useState<string | null>(null)
  const [creationProject, setCreationProject] = useState<string | null>(null)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
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
  const search = usePresence(searchOpen)
  // The search pill in Settings' window bar, when Settings was opened on its own URL (R-35).
  useEffect(() => { if (takeShellSearchRequest()) setSearchOpen(true) }, [])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || boardBusy || settingsOpen || leaving.current) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault(); setSearchOpen(value => !value)
      } else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !typingOrDialog(event.target)) {
        event.preventDefault(); setTypedAhead(''); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreating(true)
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
    void leave(() => {
      // A directly opened/reloaded detail has no remembered in-memory section.
      // Its Board breadcrumb must still return to issues, not the default Projects page.
      if (id === null && directDetail.current) changeSection(teamId ? 'team-issues' : 'all-issues')
      showIssue(id, 'push')
    }).finally(() => setPendingSelection(undefined))
    return true
  }
  function deleted() {
    flushDetail.current = null
    dirtyRef.current = false
    showIssue(null, 'replace')
  }
  const saved = useCallback((id: string) => { setSelected(id); void mutate() }, [mutate])
  function create() { if (boardBusy) return; setTypedAhead(''); setCreationProject((section === 'projects' || section === 'team-projects') ? projectId : null); setCreating(true) }
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        const result = await endSession()
        if (result.error) throw new Error('sign out failed')
        await clearCache(() => true, undefined, { revalidate: false }); router.replace('/sign-in?login=1'); router.refresh()
      } catch { setAccountError(i18nText("Workspace.signOutFailed")); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    void leave(() => { applySelection(null, 'replace'); if (['inbox', 'agent', 'coordinator', 'group', 'views', 'team-home'].includes(section)) changeSection('team-issues'); setView(next); setQuery('') })
    return true
  }
  function navigateSection(next: WorkspaceSection) {
    if (boardBusy || leaving.current) return false
    void leave(() => { applySelection(null, 'replace'); changeSection(next); if (!next.startsWith('team-')) setTeamId(null); setProjectId(null); setView(next === 'my-issues' ? 'mine' : 'all'); setQuery('') })
    return true
  }
  /** `created` is a bot made a moment ago that the bot list hasn't loaded yet. */
  function openChat(target: ChatTarget, created?: BotView) {
    if (boardBusy || leaving.current) return
    const bot = target.kind === 'bot' ? bots.find(item => item.id === target.botId) ?? (created?.id === target.botId ? created : undefined) : undefined
    if (target.kind === 'bot' && !bot) return
    void leave(() => {
      lastChat.current = target
      if (bot) setCreatedBot(created?.id === bot.id ? created : undefined)
      setActiveBotId(bot?.id ?? null)
      applySelection(null, 'replace'); changeSection(target.kind === 'agent' ? 'agent' : target.kind === 'group' ? 'group' : 'coordinator', bot?.id ?? null); setTeamId(null); setProjectId(null)
      if (target.kind === 'agent') setAgentRequest(current => ({ sessionId: target.sessionId, nonce: (current?.nonce ?? 0) + 1 }))
      if (target.kind === 'group') setGroupRequest({ id: target.id, title: target.title, workspaceId: target.workspaceId })
    })
  }
  function openRail(destination: RailDestination) {
    if (destination === 'chats') {
      // Coming back from the board reopens the chat that was showing, not a fresh one.
      const last = lastChat.current
      openChat(last.kind === 'agent' ? { kind: 'agent', sessionId: activeAgentId ?? last.sessionId } : last)
    } else if (destination === 'board') { if (navigateSection('all-issues')) setLayout('board') }
    else navigateSection(destination)
  }
  const rail: RailDestination | null = section === 'coordinator' || section === 'agent' || section === 'group' ? 'chats' : section === 'plugins' || section === 'suggestions' || section === 'artifacts' ? section : ['all-issues', 'my-issues', 'team-issues'].includes(section) ? 'board' : null
  // The board, 建议 and Artifact keep only the rail on their left (MIK-45, Figma F2/F8).
  const fullPage = rail === 'board' || rail === 'suggestions' || rail === 'artifacts' || rail === 'plugins'
  const activeBot = section === 'coordinator' && activeBotId ? bots.find(bot => bot.id === activeBotId) ?? (createdBot?.id === activeBotId ? createdBot : undefined) : undefined
  const activeChat: ChatTarget | null = section === 'coordinator' ? activeBot ? { kind: 'bot', botId: activeBot.id } : { kind: 'coordinator' } : section === 'agent' ? { kind: 'agent', sessionId: activeAgentId } : section === 'group' && groupRequest ? { kind: 'group', ...groupRequest } : null
  const beforeChange = (action: () => Promise<void>) => { if (!boardBusy && !leaving.current) void leave(action) }
  const openSettings = (href = '/settings') => { if (!boardBusy && !leaving.current) void leave(() => { if (!pushSettingsHistory(href)) router.push(href) }) }
  const isProjects = section === 'projects' || section === 'team-projects'
  // Names for group messages, only from the member list already loaded for that same workspace.
  const groupPeople = new Map(groupRequest && workspaceData?.workspace.id === groupRequest.workspaceId ? workspaceData.members.map(member => [member.userId, member.name || member.email] as const) : [])
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
  // The rail leaves routed Settings for the app page, then opens the chosen destination there.
  if (pathname.startsWith('/settings')) return <SettingsShell user={user} defaultWorkspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} googleEnabled={googleEnabled} onRail={destination => { if (pushSettingsHistory('/')) openRail(destination); else router.push('/') }}
    onSearch={() => { if (pushSettingsHistory('/')) setSearchOpen(true); else { requestShellSearch(); router.push('/') } }} onBrowser={() => { showBrowser(true); if (!pushSettingsHistory('/')) router.push('/') }} />
  const isConversation = !selected && section === 'coordinator'
  const savedSessions = new Map((agentHistory?.sessions ?? []).map(session => [session.id, session]))
  for (const session of liveSessions) savedSessions.set(session.id, { ...session, preview: session.preview ?? savedSessions.get(session.id)?.preview })
  const conversationSessions = [...savedSessions.values()]
  const lastCoordinatorItem = coordinatorChat?.items.findLast(item => item.from !== 'event')
  const dialogs = <>
    <NewTaskDialog open={creating} project={creationProject ? scopedProjects.find(project => project.id === creationProject)?.name : null} initialText={typedAhead} onOpenChange={open => { setCreating(open); if (!open) setTypedAhead('') }} />
    {onboardingOpen && <Onboarding computer={onboarding?.computer} saveKey={saveOnboardingKey} onDone={bot => { setOnboardingOpen(false); if (bot) openChat({ kind: 'bot', botId: bot.id }, bot) }} />}
    <NewBotDialog open={creatingBot} onOpenChange={setCreatingBot} onCreated={bot => { setCreatingBot(false); openChat({ kind: 'bot', botId: bot.id }, bot) }} />
    {search.value && <GlobalSearch open={search.open} onOpenChange={setSearchOpen} onOpenChangeComplete={search.onOpenChangeComplete} bots={bots} sessions={conversationSessions} coordinatorLine={lastCoordinatorItem ? chatPreview(lastCoordinatorItem.text) ?? i18nText('Nav.cardPreview') : undefined} issues={tasks} projects={projects} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null}
      onChat={openChat} onNewBot={() => setCreatingBot(true)} onIssue={open} onCreateIssue={() => create()}
      onProject={id => { void leave(() => { applySelection(null, 'replace'); changeSection('projects'); setTeamId(null); setProjectId(id) }) }} />}
  </>
  const leaveSettings = (destination: RailDestination) => { closeSettings(); openRail(destination) }
  if (settingsOpen) return <SignOutBoundary pending={signingOut}><SettingsFrame user={user} onRail={leaveSettings} onSearch={() => { closeSettings(); setSearchOpen(true) }} onBrowser={() => { closeSettings(); showBrowser(true) }} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut}>
    <SettingsView initialSection={settingsTarget.section} linearNotice={linearNotice} inviteInitially={settingsTarget.invite} user={user} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} googleEnabled={googleEnabled} onRail={leaveSettings} onSignOut={signOut} signingOut={signingOut} accountError={accountError} />
    {dialogs}
  </SettingsFrame></SignOutBoundary>
  return <SignOutBoundary pending={signingOut}><ComputerAgentsProvider><BrowserNotesProvider><AppFrame
    bar={<WindowBar center={<SearchPill onSearch={() => { if (!boardBusy) setSearchOpen(true) }} />} trailing={<>{isConversation && !browserShown && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground', panelOpen && 'xl:hidden')} aria-label={i18nText('Shell.panel.open')} onClick={openPanel} />}><PanelRight data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Shell.panel.open')}</TooltipContent></Tooltip>}<BrowserToggle open={browserShown} onToggle={() => showBrowser(!browserShown)} /></>} />}
    rail={<IconRail active={rail} onNavigate={openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={beforeChange} />}>
    {/* The board keeps only the rail on its left (MIK-45). */}
    {!fullPage && <BotList bots={bots} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null} threads={threads} active={activeChat} onOpen={openChat} onNewBot={() => setCreatingBot(true)} rail={rail} onRail={openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={beforeChange} />}
    {/* An open issue's header carries its own list toggle, so the floating one would sit on top of it. */}
    <AppShellContent listToggle={!fullPage && !selected} hideHeader={!!selected || section === 'agent' || section === 'group'} parent={section.startsWith('team-') && activeTeam ? activeTeam.name : workspaceContext?.workspace.name ?? i18nText("Settings.groups.workspace")} title={sectionTitles[section]} actions={section === 'plugins' || section === 'suggestions' || section === 'artifacts' ? undefined : <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText("Workspace.openSearch")} aria-keyshortcuts="Control+k Meta+k" disabled={boardBusy} onClick={() => setSearchOpen(true)} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText("Workspace.search.title")}<ShortcutKeys keys={['mod', 'K']} /></TooltipContent></Tooltip>}>
      {accountError && <FieldError className="px-6 py-2">{accountError}</FieldError>}
      {selected ? <TaskDetail key={draftKey} id={selected} workspaceName={workspaceContext?.workspace.name ?? i18nText('Settings.groups.workspace')} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} onDeleted={deleted} onOpen={id => open(id)} navigation={{ index: pagerIndex, total: filtered.length, onOpen: offset => { const index = filtered.findIndex(task => task.id === selected); const next = filtered[index + offset]; if (index >= 0 && next) open(next.id) } }} /> : isProjects ? <ProjectWorkspace projects={scopedProjects} loading={projectsLoading} error={!!projectError} projectId={projectId} team={section === 'team-projects' ? activeTeam?.name : undefined} initialTeamId={section === 'team-projects' ? teamId ?? undefined : undefined} issues={tasks} userName={user.name || user.email} onSelect={setProjectId} onOpenTeam={() => { navigateSection('team-projects') }} onOpenIssue={open} onCreateIssue={() => create()} onUpdated={() => { void refreshProjects(); void refreshProjectTeams() }} /> : section === 'team-home' && activeTeam ? <TeamHome key={activeTeam.id} team={activeTeam} projects={scopedProjects} issueCount={counts.all} onIssues={() => navigate('all')} onProjects={() => navigateSection('team-projects')} onProject={id => { void leave(() => { applySelection(null, 'replace'); changeSection('team-projects'); setProjectId(id) }) }} /> : section === 'group' && groupRequest ? <GroupChatView key={groupRequest.id} group={groupRequest} userId={user.id} people={groupPeople} /> : isOverview ? <WorkspaceOverview section={section} teamName={activeTeam?.name} counts={counts} projectCount={scopedProjects.length} tasks={scopedTasks} userId={user.id} initialAgentHistory={initialAgentHistory} agentRequest={agentRequest} onAgentActive={setActiveAgentId} onAgentSessions={setLiveSessions} bot={activeBot} onOpen={id => open(id)} onProjects={() => navigateSection('team-projects')} onView={navigate} /> : section === 'plugins' ? <PluginsPage key={pluginsVisit} /> : section === 'suggestions' ? <SuggestionFeed onOpenIssue={id => { open(id) }} onConnect={() => openRail('plugins')} onSent={() => { if (window.matchMedia('(max-width: 767px)').matches) openChat({ kind: 'coordinator' }) }} /> : section === 'artifacts' ? <ArtifactLibrary onOpenIssue={id => { open(id) }} /> : tasksLoading ? <DetailLoading /> : layout === 'board' ? <BoardPage issues={filtered} userId={user.id} onOpen={open} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold">{section === 'my-issues' ? i18nText("Workspace.myCreatedTasks") : viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge>{section !== 'my-issues' && <NativeSelect aria-label={i18nText("Workspace.filterStatus")} value={view} disabled={boardBusy} onChange={event => navigate(event.target.value as IssueView)}><NativeSelectOption value="all">{i18nText("Projects.allStatuses")}</NativeSelectOption><NativeSelectOption value="favorites">{i18nText("Overview.favorites")}</NativeSelectOption><NativeSelectOption value="following">{i18nText("Overview.following")}</NativeSelectOption>{ISSUE_STATUSES.map(status => <NativeSelectOption key={status.value} value={status.value}>{statusLabel(status.value)}</NativeSelectOption>)}</NativeSelect>}</div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><SearchInput className="min-w-0 sm:w-48" aria-label={i18nText("Workspace.search.title")} placeholder={i18nText("Projects.issuePicker.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /><ToggleGroup aria-label={i18nText("Workspace.taskView")} size="sm" variant="segment" spacing={0.5} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label={i18nText("Workspace.listView")}><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label={i18nText("Workspace.boardView")}><Columns3 /></ToggleGroupItem></ToggleGroup><Button size="sm" disabled={boardBusy} onClick={() => create()}><Plus data-icon="inline-start" />{i18nText("Nav.newTask")}</Button></div>
        </div>
        <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={open} onCreate={() => create()} />
      </>}
    </AppShellContent>
    {browserShown && <BrowserPane onClose={() => showBrowser(false)} />}
    {/* The panel springs only when the person opens or closes it; leaving or entering a conversation shows it at its final width. */}
    {isConversation && <AnimatePresence initial={false}>{panelOpen && !browserShown && <ContextPanel key="context-panel" workspaceId={workspaceData?.workspace.id} issues={tasks} threads={threads} onOpenIssue={id => { open(id) }} onSearch={() => setSearchOpen(true)} onClose={() => showPanel(false)}
      conversation={activeBot ? { id: activeBot.id, name: activeBot.name, color: activeBot.color, shape: activeBot.shape, kind: 'bot' } : { name: i18nText('Nav.coordinator'), kind: 'coordinator', updatedAt: lastCoordinatorItem?.createdAt }} />}</AnimatePresence>}
    {isConversation && !browserShown && <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-sm">
        <SheetHeader className="sr-only"><SheetTitle>{i18nText('Shell.panel.label')}</SheetTitle></SheetHeader>
        <ContextPanel sheet workspaceId={workspaceData?.workspace.id} issues={tasks} threads={threads} onOpenIssue={id => { setPanelSheet(false); open(id) }} onSearch={() => setSearchOpen(true)} onClose={() => setPanelSheet(false)}
      conversation={activeBot ? { id: activeBot.id, name: activeBot.name, color: activeBot.color, shape: activeBot.shape, kind: 'bot' } : { name: i18nText('Nav.coordinator'), kind: 'coordinator', updatedAt: lastCoordinatorItem?.createdAt }} />
      </SheetContent>
    </Sheet>}
    {dialogs}
  </AppFrame></BrowserNotesProvider></ComputerAgentsProvider></SignOutBoundary>
}
