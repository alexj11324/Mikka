'use client'
import { useTranslations } from 'next-intl'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { Columns3, List, Plus, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IconRail, type RailDestination } from '@/components/nav/icon-rail'
import { BotList, useChatNav, type ChatTarget } from '@/components/nav/bot-list'
import { NewGroupDialog } from '@/components/nav/new-group-dialog'
import { threadName } from '@/components/nav/thread-list'
import { NewBotDialog } from '@/components/nav/new-bot-dialog'
import type { E2BKeyResult, OnboardingComputer } from '@/components/onboarding/onboarding'
import { Onboarding } from '@ui-slot/onboarding'
import type { LegacyChatRequest } from './legacy-chat-archive'
import { TeamHome } from '@/components/teams/team-home'
import { ArtifactsPage } from '@ui-slot/artifacts'
import { MemoryPage } from '@ui-slot/memory'
import { TasksPage } from '@ui-slot/tasks'
import { INBOX_PHONE_HEADER, INBOX_TITLE, InboxPage } from '@ui-slot/inbox'
import { AppFrame, AppShellContent, FRAME_LISTS_CHATS, FRAME_OWNS_HEADER, FRAME_OWNS_PANEL, SignOutBoundary, WindowBar } from '@/components/app-shell'
import { ConversationPanels, EmbeddedTaskDetail, EmbeddedTaskLifecycle } from '@/components/coordinator/conversation-panels'
import * as settingsFrameSlot from '@ui-slot/settings-frame'
import * as reviewSummarySlot from '@ui-slot/review-summary'
import { PluginsPage } from '@ui-slot/plugins'
import { ReviewPage } from '@ui-slot/review-page'
import { closeReview, openReview, useReviewPage } from '@/hooks/code-review/use-review-page'
import { IssueList } from './issue-list'
import { BoardPage } from './board-page'
import { NewTaskDialog } from '@/components/coordinator/new-task-dialog'
import { GlobalSearch, SearchPill } from '@/components/nav/global-search'
import { ContextPanel } from '@/components/nav/context-panel'
import { GroupPanel } from '@/components/nav/group-panel'
import { ConversationPillButton } from '@/components/nav/conversation-pill'
import { GroupPillAvatar } from '@/components/nav/group-avatar'
import { BotAvatar, COORDINATOR_AVATAR } from '@/components/nav/bot-avatar'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { BrowserPane } from '@/components/browser/browser-pane'
import { browserAddressRequest, browserAddressVersion, subscribeBrowserAddress } from '@/lib/browser/navigation'
import { ThreadColumn } from './thread-column'
import { AllThreadsColumn, AllThreadsToggle } from '@/components/nav/all-threads'
import { useTaskContinuation } from '@/lib/hooks/use-task-continuation'
import { nextTaskListCursor } from '@/lib/task-list-page'
import { listWorkspaceTaskPage } from '@/app/actions/issues'
import { TaskCardDataProvider } from '@/hooks/use-task-cards'
import { TaskPresentationsContext, useWorkspaceTaskPresentations } from '@/hooks/use-task-collection'
import { groupPresentedTasks, waitingTasks } from '@/lib/task-collection'
import { useInboxCount } from '@/hooks/use-inbox-count'
import { TaskColumn } from './task-column'
import { BrowserNotesProvider } from '@/components/browser/browser-notes'
import { BrowserToggle, useBrowserFits } from '@/components/browser/browser-toggle'
import { ComputerAgentsProvider } from '@/components/computer/computer-agents'
import type { BotView } from '@/app/actions/bots'
import { chatPreview } from '@/lib/agent-history'
import { PanelRight } from 'lucide-react'
import { ISSUE_STATUSES, type IssueStatus, type IssueView } from './issue-properties'
import type { listIssues } from '@/app/actions/issues'
import { useLiveBotChatList, useLiveBotRoster, useLiveGroupList, useLiveIssueList, useLiveThreadList } from '@/hooks/use-live-lists'
import { ListReadScopeError, ownerListWorkspace, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
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
import { InlineLoadError } from '@/components/load-error'
import { SuggestionsRefresh } from '@/components/suggestions/suggestion-feed'
import { backToTaskOrigin, closeTask, dropQueryKeys, goTo, navigate as navigateWorkspace, NAVIGATE_EVENT, openedFromList, openThread, queryMoved, readLocation, sameLocation, sectionFor, taskOrigin, tidyAddress, toggleAllThreads, type WorkspaceLocation, type WorkspaceSection } from './workspace-navigation'
import { pushSettingsHistory, requestShellSearch, takeShellSearchRequest, appHrefBeforeSettings, rememberAppHref } from '@/lib/settings-navigation'
import { resolveSettingsSection, type SettingsSectionId } from '@/lib/settings-sections'
import { bufferTypeAhead, typingOrDialog } from '@/lib/shortcut-guard'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import type { AgentHistory, SavedAgentSession } from '@/lib/agent-history'
import { useAgentHistory } from '@/hooks/use-agent-history'
import { useEnterpriseSignOut } from '@/hooks/use-enterprise-sign-out'
import { useWorkspace } from '@/hooks/use-workspace'
import { LiveProvider, useLiveKey } from '@/hooks/use-live-key'
import { focusChatComposer } from '@/hooks/use-focus-return'
import { usePresence } from '@/lib/use-presence'
import { FieldError } from '@/components/ui/field'
import { ViewStateProvider, useViewState } from '@/lib/hooks/view-state'
import { AuthenticatedReadCache } from '@/components/authenticated-read-cache'
import type { AuthorizedCacheWorkspace } from '@/lib/swr/cache-scope'

// Start the chunk download during module evaluation, before hydration and its effects.
if (typeof window !== 'undefined') {
  void import('./legacy-chat-archive').catch(() => {})
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
const ArtifactWindow = dynamic(() => import('@/components/artifacts/artifact-window').then(module => module.ArtifactWindow), { ssr: false })
const ProjectWorkspace = dynamic(() => import('./project-workspace').then(module => module.ProjectWorkspace), { loading: DetailLoading })
// Settings chunks load inside the persistent frame, leaving its navigation and providers mounted.
// OWN_SETTINGS_FRAME is optional (lib/ui-overlay.mjs UI_SLOT_EXPORTS): a layer without it keeps the workspace frame.
const ownSettingsFrame = (settingsFrameSlot as { OWN_SETTINGS_FRAME?: boolean }).OWN_SETTINGS_FRAME === true
const { SettingsFrame } = settingsFrameSlot
// REVIEW_ENABLED is optional too: a layer without the review page (and the default) adds no ⌘⇧B and no 「审阅 #N」.
const reviewEnabled = (reviewSummarySlot as { REVIEW_ENABLED?: boolean }).REVIEW_ENABLED === true
// The rail's 插件 page: a layer's own (optional export, docs/ui-overlay.md), else today's store.
const SettingsRouteContent = dynamic(() => import('@/components/settings/settings-shell').then(module => module.SettingsRouteContent), { loading: WorkspaceContentLoading })
const SettingsView = dynamic(() => import('@/components/settings/settings-view').then(module => module.SettingsView), { loading: WorkspaceContentLoading })

export function IssueWorkspace({ cacheWorkspace, ...props }: Parameters<typeof IssueWorkspaceContent>[0] & { withinLiveProvider?: boolean; cacheWorkspace?: AuthorizedCacheWorkspace | null }) {
  const content = <IssueWorkspaceScope {...props} />
  return props.withinLiveProvider ? content : <AuthenticatedReadCache ownerId={props.user.id} workspace={cacheWorkspace}>{content}</AuthenticatedReadCache>
}

function IssueWorkspaceScope({ withinLiveProvider = false, ...props }: Parameters<typeof IssueWorkspaceContent>[0] & { withinLiveProvider?: boolean }) {
  const errors = useTranslations('Errors')
  const common = useTranslations('Common')
  const { data: read, error, mutate } = useWorkspace(props.user.email)
  const data = read?.currentUserId === props.user.id ? read : undefined
  // Cached chats can arrive before the workspace read. Do not accept a draft
  // in a temporary scope that would discard it when its workspace resolves.
  if (!data && error) return <InlineLoadError message={errors('workspaceReadFailed')} retryLabel={common('retry')} onRetry={() => { void mutate() }} />
  if (!data) return <WorkspaceLoading />
  const content = <ViewStateProvider scope={`${props.user.id}:${data.workspace.id}`}><IssueWorkspaceContent {...props} /></ViewStateProvider>
  return withinLiveProvider ? content : <LiveProvider ownerId={props.user.id} workspaceId={data?.workspace.id}>{content}</LiveProvider>
}

function IssueWorkspaceContent({ user, initialSelected = null, initialAgentHistory, initialSection = 'coordinator', initialSettingsSection, googleEnabled = false, onboarding }: { onboarding?: { computer: OnboardingComputer }; initialSelected?: string | null; user: { id: string; name: string; email: string; image?: string | null }; initialIssues?: Awaited<ReturnType<typeof listIssues>>; initialAgentHistory?: AgentHistory; initialSection?: WorkspaceSection; initialSettingsSection?: 'integrations' | 'account'; googleEnabled?: boolean }) {
  const i18nText = useTranslations()
  const { data: workspaceRead, error: workspaceReadError } = useWorkspace(user.email)
  const workspaceData = workspaceRead?.currentUserId === user.id ? workspaceRead : undefined
  const { data: agentHistory } = useAgentHistory(user.id, initialAgentHistory)
  const t = useTranslations('Workspace')
  const tIssue = useTranslations('Issue')
  const tPlugins = useTranslations('Plugins')
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const { data: workspaceContextRead } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const workspaceContext = workspaceContextRead?.live?.ownerId === user.id ? workspaceContextRead : undefined
  const workspaceHome = ownerListWorkspace(workspaceContext, user.id)
  useLiveKey('workspace_settings', workspaceHome ?? UNRESOLVED_LIST_SCOPE, ['/api/workspace/switcher', unstable_serialize(['/api/workspace', user.email]), 'teams', 'project-teams'], workspaceHome, { minIntervalMs: 2_000 })
  const { mutate: clearCache } = useSWRConfig()
  // The group chat in the centre (`group=<id>`): the one just opened, else found among the workspace's group chats (the bot list's own request) after a reload or back.
  const [groupId, setGroupId] = useState<string | null>(() => readLocation(params).group)
  const [openedGroup, setOpenedGroup] = useState<GroupChatRequest | null>(null)
  const groupsWorkspace = workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null
  const { data: groupList } = useLiveGroupList(user.id, groupsWorkspace, Boolean(groupId && openedGroup?.id !== groupId))
  const listedGroup = groupList?.find(group => group.id === groupId)
  const groupRequest: GroupChatRequest | null = !groupId ? null : openedGroup?.id === groupId ? openedGroup : listedGroup ? { id: listedGroup.id, title: listedGroup.title, workspaceId: listedGroup.workspaceId } : null
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
    suggestions: i18nText(INBOX_TITLE as never),
    artifacts: i18nText('Nav.artifacts'),
    memory: i18nText('HostedSettings.memory.title'),
    tasks: i18nText('Nav.tasks'),
  }
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initialSettingsSection))
  // While Settings is shown these reads are not on screen. Paused, they cannot queue
  // server actions ahead of a settings save (Next runs a page's actions one at a time).
  const settingsShown = settingsOpen || pathname.startsWith('/settings')
  // The app page last shown outside Settings, for Settings' way back (backFromSettings).
  const appQuery = params.toString()
  useEffect(() => { if (!settingsShown) rememberAppHref(`${pathname}${appQuery ? `?${appQuery}` : ''}`) }, [settingsShown, pathname, appQuery])
  const inSettings = useRef(settingsShown)
  inSettings.current = settingsShown
  const whileSettings = { isPaused: () => inSettings.current }
  const [settingsTarget, setSettingsTarget] = useState<{ section: SettingsSectionId; invite: boolean }>({ section: initialSettingsSection ? resolveSettingsSection('/settings', initialSettingsSection) : 'preferences', invite: false })
  const [linearNotice, setLinearNotice] = useState<'connected' | 'error' | null>(null)
  useEffect(() => {
    const result = new URL(window.location.href).searchParams.get('linear')
    if (result !== 'connected' && result !== 'error') return
    setSettingsOpen(true)
    setSettingsTarget({ section: 'connections', invite: false })
    setLinearNotice(result)
    dropQueryKeys('linear')
  }, [])
  const [boardBusy, setBoardBusy] = useState(false)
  const listWorkspaceId = workspaceData?.workspace.id ?? workspaceContext?.workspace.id
  const listsPaused = boardBusy || settingsShown
  const { data: taskList, mutate, error, isLoading: tasksLoading } = useLiveIssueList(user.id, listWorkspaceId, listsPaused)
  const firstTasks = useMemo(() => taskList?.items ?? [], [taskList])
  const paging = useTaskContinuation(firstTasks, taskList, nextTaskListCursor(firstTasks), async after => {
    if (!listWorkspaceId) throw new Error('workspaceAccessDenied')
    const page = await listWorkspaceTaskPage({ workspaceId: listWorkspaceId, after })
    if (page.reset) { await mutate(); throw new Error('issueStale') }
    return page
  })
  const tasks = useMemo(() => [...paging.items], [paging.items])
  const presentation = useWorkspaceTaskPresentations(user.id, listWorkspaceId, workspaceHome, tasks, !listsPaused)
  useEffect(() => {
    if (!(error instanceof ListReadScopeError) || error.kind !== 'workspace') return
    // Revoked membership may make the normal server context select the home.
    // Clear the inaccessible list, then resolve that context through its usual
    // authorized reads; never cache the replacement workspace under the old key.
    void clearCache('/api/workspace/switcher')
    void clearCache(['/api/workspace', user.email])
  }, [error, clearCache, user.email])
  // Keep failed refreshes out of document flow so the board/list never jumps.
  const listErrorMessage = t('listError')
  useEffect(() => {
    const id = `issue-list-error-${user.id}`
    if (error || presentation.error) toast.error(listErrorMessage, { id, duration: Infinity })
    else toast.dismiss(id)
    return () => { toast.dismiss(id) }
  }, [error, presentation.error, listErrorMessage, user.id])
  const { data: projects = [], error: projectError, isLoading: projectsLoading, mutate: refreshProjects } = useSWR(['projects', user.id], listProjects, whileSettings)
  const { data: teams = [] } = useSWR('teams', listTeams, whileSettings)
  const { data: projectTeams = [], mutate: refreshProjectTeams } = useSWR('project-teams', listProjectTeams, whileSettings)
  const { data: botList } = useLiveBotRoster(user.id, listWorkspaceId, settingsShown)
  const bots = botList?.items ?? []
  const [onboardingOpen, setOnboardingOpen] = useState(Boolean(onboarding))
  const { data: threadList, error: threadsError, mutate: refreshThreads } = useLiveThreadList(user.id, listsPaused)
  const threads = useMemo(() => threadList?.items ?? [], [threadList])
  // Not read yet: the thread lists show rows' shapes instead of 还没有线程 (review C7).
  const threadsLoading = threadList === undefined && !threadsError
  const listsWerePaused = useRef(listsPaused)
  useEffect(() => {
    if (listsWerePaused.current && !listsPaused) {
      void mutate()
      void refreshThreads()
    }
    listsWerePaused.current = listsPaused
  }, [listsPaused, mutate, refreshThreads])
  const [creatingBot, setCreatingBot] = useState(false)
  // 新建群聊 from a frame that lists the chats itself (FRAME_LISTS_CHATS); the bot list keeps its own otherwise.
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [createdBot, setCreatedBot] = useState<BotView>()
  // The Coordinator's last line and time come from the bot chat summaries, never its whole chat.
  const { data: botChatSummaries } = useLiveBotChatList(user.id)
  const [panelOpen, setPanelOpen] = useState(true)
  // FRAME_OWNS_PANEL: which of the chat's work-area tabs the page last asked to show, counting up each time.
  const [panelReveal, setPanelReveal] = useState<{ reveal: number; revealId: 'overview' | 'browser' | null }>({ reveal: 0, revealId: null })
  const browserRequestVersion = useSyncExternalStore(subscribeBrowserAddress, browserAddressVersion, () => 0)
  const handledBrowserRequest = useRef(browserAddressRequest() ? 0 : browserRequestVersion)
  useEffect(() => { try { if (window.localStorage.getItem('mikka:context-panel') === '0') setPanelOpen(false) } catch { /* storage unavailable */ } }, [])
  // Below xl the column has no room, so 打开右栏 shows it in a Sheet instead.
  const [panelSheet, setPanelSheet] = useState(false)
  // The thread open in the right column, beside the chat or the task (R-82); its address is ?thread=.
  const [threadId, setThreadId] = useState<string | null>(() => readLocation(params).thread)
  // A task open in the right column (decision 2026-11-07-2045); a thread opened from it sits over it.
  const [taskId, setTaskId] = useState<string | null>(() => readLocation(params).task)
  // The Artifact open in its window over the page (R-56, R-82); its address is ?artifact=.
  const [artifactId, setArtifactId] = useState<string | null>(() => readLocation(params).artifact)
  // 全部线程 in the right column, from any page (?threads=all, or one bot's id).
  const [threadsView, setThreadsView] = useState<string | null>(() => readLocation(params).threads)
  // 全部线程's button counts the threads waiting on you (Figma 802:56).
  const taskGroups = useMemo(() => groupPresentedTasks(tasks, threads, presentation.items, 'workspace'), [tasks, threads, presentation.items])
  const threadsWaiting = useMemo(() => waitingTasks(taskGroups, []).length, [taskGroups])
  // The count on 收件箱, for a frame that shows it there (FRAME_OWNS_HEADER): what the Inbox lists, from the same reads.
  const inboxItems = useInboxCount(threads, taskGroups, FRAME_OWNS_HEADER)
  // FRAME_OWNS_HEADER: no 全部线程 list beside the page (the frame shows the waiting count on 收件箱); an old address
  // keeps its open thread beside the page it was on, and without one lands on 任务.
  useEffect(() => {
    if (FRAME_OWNS_HEADER && threadsView) goTo(threadId ? { threads: null } : { threads: null, section: 'tasks' }, 'replace')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the old address moves; the thread goes with it
  }, [threadsView])
  const tasksPending = threadsWaiting
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
  const [teamId, setTeamId] = useState<string | null>(() => readLocation(params).team)
  const activeTeam = teams.find(team => team.id === teamId)
  const [section, setSection] = useState<WorkspaceSection>(() => { const at = readLocation(params); return at.team || at.group ? at.section : initialSection })
  const [pluginsVisit, setPluginsVisit] = useState(0)
  // True only while the detail was loaded directly and no section has been chosen since.
  const directDetail = useRef(initialSelected !== null)
  /** Shows `next` and returns the address change for it; the caller writes it with goTo, once per move. */
  function changeSection(next: WorkspaceSection, botId: string | null = null): Partial<WorkspaceLocation> {
    directDetail.current = false
    setSection(next)
    sectionRef.current = next
    // Choosing the plugins page opens its top, not an app's page left open before.
    if (next === 'plugins') setPluginsVisit(visit => visit + 1)
    return { section: next, bot: next === 'coordinator' ? botId : null }
  }
  const sectionRef = useRef(section)
  const [agentRequest, setAgentRequest] = useState<LegacyChatRequest | undefined>(() => { const session = readLocation(params).session; return session ? { sessionId: session, nonce: 0 } : undefined })
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  // The bot whose chat is in the center; null for the Coordinator. Every bot chat runs on the Coordinator harness.
  const [activeBotId, setActiveBotId] = useState<string | null>(initialSection === 'coordinator' ? params.get('bot') : null)
  // Historical chat records are read-only.
  const [liveSessions, setLiveSessions] = useState<SavedAgentSession[]>([])
  const lastChat = useRef<ChatTarget>(initialSection === 'agent' ? { kind: 'agent', sessionId: null } : params.get('bot') ? { kind: 'bot', botId: params.get('bot')! } : { kind: 'coordinator' })
  const [projectId, setProjectId] = useState<string | null>(() => readLocation(params).project)
  const [layout, setLayout] = useViewState<'board' | 'list'>('issues:layout', 'board')
  const [selected, setSelected] = useState<string | null>(initialSelected)
  const [pendingSelection, setPendingSelection] = useState<string | null | undefined>(undefined)
  const selectedRef = useRef(selected)
  const [draftKey, setDraftKey] = useState(0)
  const dirtyRef = useRef(false)
  const flushDetail = useRef<(() => Promise<boolean>) | null>(null)
  const embeddedEditors = useRef(new Map<symbol, () => Promise<boolean>>())
  const embeddedLifecycle = useMemo(() => ({
    onSaved: () => { void mutate() },
    register: (owner: symbol, flush: (() => Promise<boolean>) | null) => {
      if (flush) embeddedEditors.current.set(owner, flush)
      else embeddedEditors.current.delete(owner)
    },
  }), [mutate])
  const leaving = useRef(false)
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => { flushDetail.current = flush }, [])
  /** Shows the task; the caller writes the address. */
  function applySelection(id: string | null) {
    selectedRef.current = id
    setSelected(id)
    setDraftKey(value => value + 1)
  }
  const issueScope = `${section}:${section.startsWith('team-') ? teamId ?? 'all' : 'all'}`
  const [issueFilters, setIssueFilters] = useViewState<Record<string, { query: string; view: IssueView }>>('issue-filters', {})
  const { query, view } = issueFilters[issueScope] ?? { query: '', view: section === 'my-issues' ? 'mine' : 'all' }
  function setQuery(query: string) { setIssueFilters(current => ({ ...current, [issueScope]: { ...(current[issueScope] ?? { view }), query } })) }
  function setView(view: IssueView, scope = issueScope) { setIssueFilters(current => ({ ...current, [scope]: { ...(current[scope] ?? { query: '' }), view } })) }
  const [creating, setCreating] = useState(false)
  const [typedAhead, setTypedAhead] = useState('')
  const isProjects = section === 'projects' || section === 'team-projects'
  const scopedProjects = section.startsWith('team-') && teamId ? projects.filter(project => projectTeams.some(link => link.projectId === project.id && link.teamId === teamId)) : projects
  const selectedProject = isProjects && projectId ? scopedProjects.find(project => project.id === projectId) : undefined
  const creationWorkspace = workspaceContext?.workspace.id ?? workspaceData?.workspace.id
  const creationScopeReady = Boolean(creationWorkspace && (!section.startsWith('team-') || activeTeam)
    && (!isProjects || !projectId || selectedProject))
  const create = useCallback(() => {
    if (boardBusy || !creationScopeReady) return
    setTypedAhead('')
    setCreating(true)
  }, [boardBusy, creationScopeReady])
  const [searchOpen, setSearchOpen] = useState(false)
  const search = usePresence(searchOpen)
  const searchFromBarRef = useRef<() => void>(() => {})
  // The search pill in Settings' window bar, when Settings was opened on its own URL (R-35).
  useEffect(() => { if (takeShellSearchRequest()) setSearchOpen(true) }, [])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || boardBusy || leaving.current) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault()
        if (inSettings.current) searchFromBarRef.current()
        else setSearchOpen(value => !value)
      } else if (!inSettings.current && event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !typingOrDialog(event.target)) {
        event.preventDefault()
        create()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [creating, searchOpen, boardBusy, create])
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
  const enterpriseSignOut = useEnterpriseSignOut()
  const [accountError, setAccountError] = useState('')
  const onDirty = useCallback((value: boolean) => { dirtyRef.current = value }, [])
  async function leave(action: () => void | Promise<void>) {
    leaving.current = true
    try {
      for (const flush of embeddedEditors.current.values()) if (!await flush()) return false
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
  /** Writes the workspace's own move; a new centre closes the open thread (workspaceHref), so the column follows the address. */
  function move(change: Partial<WorkspaceLocation>, mode: 'push' | 'replace' = 'push', list = false) {
    goTo(change, mode, { list })
    const at = readLocation(new URL(window.location.href).searchParams)
    setThreadId(at.thread); setTaskId(at.task); setArtifactId(at.artifact); setGroupId(at.group); setThreadsView(at.threads)
  }
  /** What is on screen, as an address; back and forward compare against it. */
  const shownRef = useRef<WorkspaceLocation>(readLocation(params))
  sectionRef.current = section
  shownRef.current = { section, bot: section === 'coordinator' ? activeBotId : null, group: section === 'group' ? groupId : null, session: section === 'agent' ? agentRequest?.sessionId ?? null : null, team: section.startsWith('team-') ? teamId : null, project: section === 'projects' || section === 'team-projects' ? projectId : null, issue: selectedRef.current, task: taskId, thread: threadId, artifact: artifactId, threads: threadsView }
  /** Back, forward or a component's navigate() landed on `next`: show it without writing the address again. */
  function showLocation(next: WorkspaceLocation) {
    const shown = shownRef.current
    // The same task stays mounted (its editor, scroll and open thread tab) when only the thread changes.
    if (next.issue !== shown.issue) applySelection(next.issue)
    setThreadId(next.thread); setTaskId(next.task); setArtifactId(next.artifact); setGroupId(next.group); setProjectId(next.project); setThreadsView(next.threads)
    if (next.thread || next.threads) setPanelSheet(false)
    if (next.section === 'agent' && next.session !== shown.session) setAgentRequest(current => ({ sessionId: next.session, nonce: (current?.nonce ?? 0) + 1 }))
    if (next.section === shown.section && next.bot === shown.bot && next.team === shown.team) return
    const target: ChatTarget = next.bot ? { kind: 'bot', botId: next.bot } : { kind: 'coordinator' }
    if (next.section === 'coordinator') { lastChat.current = target; setActiveBotId(next.bot) }
    changeSection(next.section, next.bot)
    setTeamId(next.team)
  }
  const showLocationRef = useRef(showLocation)
  showLocationRef.current = showLocation
  useEffect(() => {
    function onPop() {
      if (!queryMoved()) return
      show()
    }
    /** A component moved through navigate(): the address is already written. */
    function show() {
      const next = readLocation(new URL(window.location.href).searchParams)
      const previous = shownRef.current
      if (sameLocation(next, previous)) return
      void (async () => {
        const ok = await leaveRef.current(() => { showLocationRef.current(next) })
        // A task with unsaved changes stays open, and so does its address.
        if (!ok) move(previous, 'replace')
      })()
    }
    queryMoved()
    window.addEventListener('popstate', onPop)
    window.addEventListener(NAVIGATE_EVENT, show)
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener(NAVIGATE_EVENT, show) }
  }, [])
  // An unknown section, a key that is not an id, and (once the list has loaded) a bot that is not one of the person's:
  // the address rewrites itself to the chat or page shown, with no new entry (R-82).
  useEffect(() => {
    if (settingsShown) return
    const known = botList && ((id: string) => id === createdBot?.id || botList.items.some(bot => bot.id === id && !bot.coordinator))
    if (known && activeBotId && !known(activeBotId)) { setActiveBotId(null); if (lastChat.current.kind === 'bot') lastChat.current = { kind: 'coordinator' } }
    tidyAddress(known || undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new bot list or leaving Settings makes the address stale; the workspace's own moves write it whole
  }, [botList, settingsShown])
  function closeSettings() {
    setSettingsOpen(false)
    dropQueryKeys('settings')
  }
  /** `fromList`: the board, a list or a project opened it, so its ↑↓ step through that list. */
  function open(id: string | null, fromList = false) {
    if (boardBusy || leaving.current) return false
    setPendingSelection(id)
    void leave(() => {
      // ✕ on a task opened by a move in this page load steps back there: the chat as it was, its open thread too (R-82).
      if (id === null && backToTaskOrigin()) return
      // Opened directly (a link, a reload), ✕ goes to the place its address names; a bare link names none and goes to the board.
      const back = id === null && directDetail.current && !taskOrigin(new URL(window.location.href).searchParams) ? changeSection(teamId ? 'team-issues' : 'all-issues') : {}
      if (id === null) directDetail.current = false
      applySelection(id)
      move({ ...back, issue: id }, 'push', fromList)
    }).finally(() => setPendingSelection(undefined))
    return true
  }
  const openFromList = (id: string) => open(id, true)
  function deleted() {
    flushDetail.current = null
    dirtyRef.current = false
    applySelection(null)
    move({ issue: null }, 'replace')
  }
  const saved = useCallback((id: string) => { setSelected(id); void mutate() }, [mutate])
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        // A company sign-in session signs out at its IdP (OIDC / SAML); with none, the existing sign-out below.
        if (await enterpriseSignOut().catch(() => false)) { await clearCache(() => true, undefined, { revalidate: false }); return }
        const result = await endSession()
        if (result.error) throw new Error('sign out failed')
        await clearCache(() => true, undefined, { revalidate: false }); router.replace('/sign-in?login=1'); router.refresh()
      } catch { setAccountError(i18nText("Workspace.signOutFailed")); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    // A filter replaces the entry; leaving a page for the task list is a move.
    void leave(() => { applySelection(null); const change = ['inbox', 'agent', 'coordinator', 'group', 'views', 'team-home'].includes(section) ? changeSection(sectionFor('team-issues', teamId)) : {}; move({ ...change, issue: null }, 'section' in change ? 'push' : 'replace'); const target = change.section ?? section; setView(next, `${target}:${target.startsWith('team-') ? teamId ?? 'all' : 'all'}`) })
    return true
  }
  function navigateSection(page: WorkspaceSection) {
    if (boardBusy || leaving.current) return false
    // A team page keeps the team in the address; without one it is the workspace's own page.
    const next = sectionFor(page, teamId)
    void leave(() => { applySelection(null); move({ ...changeSection(next), issue: null, project: null }); if (!next.startsWith('team-')) setTeamId(null); setProjectId(null) })
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
      applySelection(null); move({ ...changeSection(target.kind === 'agent' ? 'agent' : target.kind === 'group' ? 'group' : 'coordinator', bot?.id ?? null), issue: null, group: target.kind === 'group' ? target.id : null, session: target.kind === 'agent' ? target.sessionId : null }); setTeamId(null); setProjectId(null)
      if (target.kind === 'agent') setAgentRequest(current => ({ sessionId: target.sessionId, nonce: (current?.nonce ?? 0) + 1 }))
      if (target.kind === 'group') setOpenedGroup({ id: target.id, title: target.title, workspaceId: target.workspaceId })
      focusChatComposer()
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
  const rail: RailDestination | null = section === 'coordinator' || section === 'agent' || section === 'group' ? 'chats' : section === 'plugins' || section === 'suggestions' || section === 'artifacts' ? section : ['all-issues', 'my-issues', 'projects'].includes(section) || section.startsWith('team-') ? 'board' : null
  // The board (projects and team pages live under it, R-82), 建议 and Artifact keep only the rail on their left (MIK-45, Figma F2/F8).
  const fullPage = rail === 'board' || rail === 'suggestions' || rail === 'artifacts' || rail === 'plugins' || section === 'memory' || section === 'tasks'
  // The Coordinator's bot row opens as the Coordinator's chat, never as a second bot.
  const coordinatorBot = bots.find(bot => bot.coordinator)
  const activeBot = section === 'coordinator' && activeBotId && activeBotId !== coordinatorBot?.id ? bots.find(bot => bot.id === activeBotId) ?? (createdBot?.id === activeBotId ? createdBot : undefined) : undefined
  const activeChat: ChatTarget | null = section === 'coordinator' ? activeBot ? { kind: 'bot', botId: activeBot.id } : { kind: 'coordinator' } : section === 'agent' ? { kind: 'agent', sessionId: activeAgentId } : section === 'group' && groupRequest ? { kind: 'group', ...groupRequest } : null
  // The same rows as the bot list, for a frame that draws its own navigation (RailProps.chats).
  const { entries: chatNav, reloadGroups } = useChatNav({ bots, workspaceId: workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null, active: activeChat, userId: user.id, threads, issues: tasks })
  const beforeChange = (action: () => Promise<void>) => { if (!boardBusy && !leaving.current) void leave(action) }
  const openSettings = (href = '/settings') => { if (!boardBusy && !leaving.current) void leave(() => { if (!pushSettingsHistory(href)) router.push(href) }) }
  // Names for group messages, only from the member list already loaded for that same workspace.
  const groupPeople = new Map(groupRequest && workspaceData?.workspace.id === groupRequest.workspaceId ? workspaceData.members.map(member => [member.userId, member.name || member.email] as const) : [])
  const isOverview = ['inbox', 'agent', 'coordinator', 'views', 'team-home'].includes(section)
  const scopedTasks = section.startsWith('team-') && teamId ? tasks.filter(task => task.teamId === teamId) : tasks
  const filtered = scopedTasks.filter(task => (view === 'all' || (view === 'mine' ? task.ownerId === user.id : view === 'shared' ? task.ownerId !== user.id : view === 'favorites' ? task.metadata.favoriteUserIds.includes(user.id) : view === 'following' ? task.metadata.subscriberUserIds.includes(user.id) : task.status === view)) && `${task.identifier ?? ''} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()))
  const counts: Record<IssueView, number> = { all: scopedTasks.length, mine: 0, shared: 0, favorites: 0, following: 0, backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0, duplicate: 0 }
  for (const task of scopedTasks) {
    if (ISSUE_STATUSES.some(status => status.value === task.status)) counts[task.status as IssueStatus]++
    counts[task.ownerId === user.id ? 'mine' : 'shared']++
    if (task.metadata.favoriteUserIds.includes(user.id)) counts.favorites++
    if (task.metadata.subscriberUserIds.includes(user.id)) counts.following++
  }
  const viewTitle = view === 'all' ? t('allIssues') : view === 'mine' ? t('mine') : view === 'shared' ? t('shared') : view === 'favorites' ? t('favorites') : view === 'following' ? t('following') : statusLabel(view)
  const pagerId = pendingSelection !== undefined ? pendingSelection : selected
  // ↑↓ step through the list that opened the task; opened from a chat, ⌘K or a link, there is no list to step through.
  const pagerIndex = pagerId && openedFromList() ? filtered.findIndex(task => task.id === pagerId) : -1
  const boardLabel = i18nText('IssueDetail.breadcrumbBoard')
  // The task page's first crumb is where it was opened from (a bare link: the board), and returns there.
  // A bot's chat is named after the bot; '' while the bot list loads, so the Coordinator never flashes in.
  const chatTitle = activeBot?.name ?? (activeBotId && activeBotId !== coordinatorBot?.id && !botList ? '' : sectionTitles.coordinator)
  const originLabel = directDetail.current && !taskOrigin(params) ? boardLabel
    : section === 'coordinator' ? chatTitle
    : rail === 'board' ? boardLabel
    : isProjects ? scopedProjects.find(project => project.id === projectId)?.name ?? sectionTitles[section]
    : sectionTitles[section]
  const isConversation = !selected && section === 'coordinator'
  // Work tabs consume their one-shot URL. Keep Review on the actual active tab in this conversation only.
  const conversationScope = `${user.id}:${workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? ''}:${activeBot?.id ?? 'coordinator'}`
  const currentConversationScope = useRef(conversationScope)
  currentConversationScope.current = conversationScope
  const [activeWorkTask, setActiveWorkTask] = useState<{ scope: string; taskId: string | null } | null>(null)
  const onActiveWorkTask = useCallback((taskId: string | null) => {
    if (currentConversationScope.current !== conversationScope) return
    setActiveWorkTask(current => current?.scope === conversationScope && current.taskId === taskId ? current : { scope: conversationScope, taskId })
  }, [conversationScope])
  // A group chat has its own 详情 in the right column (R-13): members, no computer.
  const groupPanel = !selected && section === 'group' && groupRequest ? groupRequest : null
  // An open thread takes the right column beside the chat or a page (R-82); a task shows its own threads in its own right column,
  // but a thread opened from 全部线程 stays in 全部线程's column.
  const threadShown = threadId && (!selected || threadsView) ? threadId : null
  const shownThread = threadShown ? threads.find(thread => thread.id === threadShown) : undefined
  // One thing on the right at a time: the thread, else 全部线程, else the browser, else 概览.
  // A task beside the centre (decision 2026-11-07-2045); not when the same task is the centre page.
  const taskShown = taskId && taskId !== selected ? taskId : null
  const rightTaken = browserShown || !!threadShown || !!threadsView || !!taskShown
  // The task in front of the person, for ⌘⇧B and ⌘K 「审阅 #N」, including the active work-area tab after its URL is consumed.
  const reviewTarget = taskShown ?? shownThread?.issueId ?? selected ?? (isConversation && activeWorkTask?.scope === conversationScope ? activeWorkTask.taskId : null)
  const review = useReviewPage()
  useEffect(() => {
    if (!reviewEnabled || !reviewTarget) return
    const target = reviewTarget
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || inSettings.current) return
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'b') return
      if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')) return
      event.preventDefault()
      openReview(target)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [reviewTarget])
  // On a phone the chat's pill sits in its header and opens the right column as a page over the chat (R-82).
  const chatHeading = isConversation ? <ConversationPillButton name={activeBot ? activeBot.name : i18nText('Nav.coordinator')} avatar={<BotAvatar {...(activeBot ? { id: activeBot.id, color: activeBot.color, shape: activeBot.shape } : COORDINATOR_AVATAR)} size="pill" />} onOpen={() => FRAME_OWNS_PANEL ? setPanelReveal(value => ({ reveal: value.reveal + 1, revealId: 'overview' })) : setPanelSheet(true)} />
    : groupPanel ? <ConversationPillButton name={groupPanel.title || i18nText('GroupChat.untitled')} avatar={<GroupPillAvatar id={groupPanel.id} title={groupPanel.title || i18nText('GroupChat.untitled')} />} onOpen={() => setPanelSheet(true)} /> : undefined
  // A frame that owns the right-hand panel (FRAME_OWNS_PANEL) takes the chat's Overview and the browser as tabs of the
  // conversation's own work area; nothing stands beside the chat. Both wait folded until asked for: the work area's
  // + (its Tools), ⌘⇧B for the browser, or the phone's chat pill for the Overview.
  const panelsInFrame = FRAME_OWNS_PANEL && isConversation
  // One address opener serves chat tabs and the existing browser column on other pages.
  useEffect(() => {
    if (!browserRequestVersion || handledBrowserRequest.current === browserRequestVersion) return
    handledBrowserRequest.current = browserRequestVersion
    if (panelsInFrame) setPanelReveal(value => ({ reveal: value.reveal + 1, revealId: 'browser' }))
    else {
      if (threadId || taskId || threadsView) navigateWorkspace({ thread: null, task: null, threads: null }, 'replace')
      showBrowser(true)
    }
  }, [browserRequestVersion, panelsInFrame, threadId, taskId, threadsView])
  const conversationPanels = panelsInFrame ? { ...panelReveal, onActiveTask: onActiveWorkTask, tabs: [
    { id: 'overview' as const, title: i18nText('Shell.panel.overview'), content: <ContextPanel key="context-panel" sheet frameTab workspaceId={workspaceData?.workspace.id} issues={tasks} threads={threads} threadsLoading={threadsLoading} onOpenThread={thread => openThread(thread.runId)} onClose={() => {}}
      conversation={activeBot ? { id: activeBot.id, name: activeBot.name, color: activeBot.color, shape: activeBot.shape, kind: 'bot' } : { id: coordinatorBot?.id, name: i18nText('Nav.coordinator'), kind: 'coordinator', updatedAt: botChatSummaries && coordinatorBot ? botChatSummaries.items[coordinatorBot.id]?.at ?? undefined : undefined }} /> },
    { id: 'browser' as const, title: i18nText('Browser.label'), content: <BrowserPane inTab onClose={() => showBrowser(false)} /> },
  ] } : undefined
  const savedSessions = new Map((agentHistory?.sessions ?? []).map(session => [session.id, session]))
  for (const session of liveSessions) savedSessions.set(session.id, { ...session, preview: session.preview ?? savedSessions.get(session.id)?.preview })
  const conversationSessions = [...savedSessions.values()]
  const coordinatorSummary = coordinatorBot ? botChatSummaries?.items[coordinatorBot.id] : undefined
  const coordinatorUpdatedAt = coordinatorSummary?.at ?? undefined
  const dialogs = <>
    {creationScopeReady && <NewTaskDialog
      key={JSON.stringify([user.id, creationWorkspace, section, activeTeam?.id, selectedProject?.id, activeBot?.id])}
      workspaceId={creationWorkspace} open={creating} initialBotId={activeBot?.id}
      teamId={section.startsWith('team-') ? activeTeam?.id : undefined} projectId={selectedProject?.id} project={selectedProject?.name}
      initialIntent={['tasks', 'my-issues', 'all-issues', 'team-issues', 'projects', 'team-projects'].includes(section) ? 'create_only' : 'create_and_dispatch'}
      onCreated={id => { void mutate(); open(id) }} initialText={typedAhead}
      onOpenChange={open => { setCreating(open); if (!open) setTypedAhead('') }} />}
    {onboardingOpen && <Onboarding computer={onboarding?.computer} saveKey={saveOnboardingKey} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} onDone={bot => { setOnboardingOpen(false); if (bot) openChat({ kind: 'bot', botId: bot.id }, bot) }} />}
    {FRAME_LISTS_CHATS && (workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null) && <NewGroupDialog key={workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null} workspaceId={(workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null)!} bots={bots} open={creatingGroup} onOpenChange={setCreatingGroup}
      onCreated={group => { setCreatingGroup(false); void reloadGroups().catch(() => {}); openChat({ kind: 'group', ...group }) }}
      onNewBot={() => { setCreatingGroup(false); setCreatingBot(true) }} onReviewGroups={() => { setCreatingGroup(false); void reloadGroups().catch(() => {}) }} />}
    <NewBotDialog open={creatingBot} onOpenChange={setCreatingBot} onCreated={bot => { setCreatingBot(false); openChat({ kind: 'bot', botId: bot.id }, bot) }} />
    {search.value && <GlobalSearch open={search.open} onOpenChange={setSearchOpen} onOpenChangeComplete={search.onOpenChangeComplete} bots={bots} sessions={conversationSessions} coordinatorLine={coordinatorSummary?.line ? chatPreview(coordinatorSummary.line) ?? i18nText('Nav.cardPreview') : undefined} issues={tasks} projects={projects} threads={threads} onThread={runId => openThread(runId)} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null}
      onChat={openChat} onNewBot={() => setCreatingBot(true)} onIssue={open} onCreateIssue={() => create()}
      reviewTaskId={reviewEnabled ? reviewTarget : null} onReview={reviewEnabled ? openReview : undefined}
      onProject={id => { void leave(() => { applySelection(null); move({ ...changeSection('projects'), issue: null, project: id }); setTeamId(null); setProjectId(id) }) }} />}
    {/* One review page for the app (R1), whichever entry opened it; the default slot draws nothing. */}
    {review.taskId && <ReviewPage taskId={review.taskId} onClose={closeReview} />}
  </>
  // Both Settings entry paths leave through the same mounted workspace shell.
  const leaveSettings = (destination: RailDestination) => {
    closeSettings()
    if (pathname.startsWith('/settings') && !pushSettingsHistory('/')) { router.push('/'); return }
    openRail(destination)
  }
  // ← in a Settings frame returns to the app page shown before Settings opened, or home.
  const backFromSettings = () => {
    const href = appHrefBeforeSettings()
    if (!href) { leaveSettings('chats'); return }
    closeSettings()
    if (!pathname.startsWith('/settings')) return
    // A workspace remounted under Settings shows the address it is given, as for any in-app move.
    if (pushSettingsHistory(href)) window.dispatchEvent(new Event(NAVIGATE_EVENT))
    else router.push(href)
  }
  const searchFromBar = () => {
    if (boardBusy) return
    if (settingsShown) closeSettings()
    if (pathname.startsWith('/settings') && !pushSettingsHistory('/')) { requestShellSearch(); router.push('/'); return }
    setSearchOpen(true)
  }
  searchFromBarRef.current = searchFromBar
  const browserFromSettings = () => {
    closeSettings(); showBrowser(true)
    if (pathname.startsWith('/settings') && !pushSettingsHistory('/')) router.push('/')
  }
  const settingsContent = pathname.startsWith('/settings')
    ? <SettingsRouteContent user={user} defaultWorkspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} googleEnabled={googleEnabled} onRail={leaveSettings} onSignOut={signOut} signingOut={signingOut} accountError={accountError} />
    : <SettingsView initialSection={settingsTarget.section} linearNotice={linearNotice} inviteInitially={settingsTarget.invite} user={user} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} googleEnabled={googleEnabled} onRail={leaveSettings} onSignOut={signOut} signingOut={signingOut} accountError={accountError} />
  // A UI layer with its own settings frame (docs/ui-overlay.md) draws settings in it;
  // the default keeps the workspace frame mounted around settings (#1603).
  // Both visual frames share the workspace's pending notes and computer registry.
  return <TaskPresentationsContext value={presentation.items}><TaskCardDataProvider key={JSON.stringify([user.id, listWorkspaceId])} ownerId={user.id} workspaceId={listWorkspaceId}><SignOutBoundary pending={signingOut}><EmbeddedTaskLifecycle value={embeddedLifecycle}><ComputerAgentsProvider><BrowserNotesProvider>{settingsShown && ownSettingsFrame
    ? <SettingsFrame user={user} onRail={leaveSettings} onBack={backFromSettings} onSearch={searchFromBar} onBrowser={browserFromSettings} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut}>{settingsContent}</SettingsFrame>
    : <AppFrame settings={settingsShown}
    bar={FRAME_OWNS_HEADER ? <WindowBar center={null} /> : <WindowBar center={<SearchPill onSearch={searchFromBar} />} trailing={<>{!settingsShown && (isConversation || groupPanel) && !rightTaken && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground', panelOpen && 'xl:hidden')} aria-label={i18nText('Shell.panel.open')} onClick={openPanel} />}><PanelRight data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Shell.panel.open')}</TooltipContent></Tooltip>}{!settingsShown && <AllThreadsToggle open={!!threadsView} waiting={threadsWaiting} pending={tasksPending} onToggle={() => toggleAllThreads(!threadsView)} />}<BrowserToggle open={!settingsShown && browserShown && !threadsView} onToggle={settingsShown ? browserFromSettings : () => { if (threadsView) { toggleAllThreads(false); showBrowser(true) } else showBrowser(!rightTaken) }} /></>} />}
    rail={<IconRail active={settingsShown ? null : rail} onNavigate={settingsShown ? leaveSettings : openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={settingsShown ? undefined : beforeChange} chats={{ workspaceId: workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null, entries: chatNav, onOpen: openChat, onNewBot: () => setCreatingBot(true), onNewGroup: () => setCreatingGroup(true) }} onSearch={searchFromBar} inboxCount={inboxItems} />}>
    {settingsShown ? settingsContent
      : <>
    {/* The board keeps only the rail on its left (MIK-45); a phone, with no rail, keeps the list's sheet. */}
    {!FRAME_LISTS_CHATS && <BotList phoneOnly={fullPage} bots={bots} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id ?? null} threads={threads} issues={tasks} active={activeChat} onOpen={openChat} onNewBot={() => setCreatingBot(true)} rail={rail} onRail={openRail} user={user} onSettings={openSettings} onSignOut={signOut} signingOut={signingOut} onBeforeChange={beforeChange} />}
    {/* An open issue's header carries its own list toggle, so the floating one would sit on top of it; every other page keeps the phone header and its list button. */}
    <AppShellContent scrollKey={`page:${section}:${teamId ?? ""}:${selected ?? projectId ?? activeBot?.id ?? groupId ?? ""}:${params.get("app") ?? ""}:${layout}`} listToggle={!fullPage && !selected} hideHeader={!!selected || (section === 'suggestions' && !INBOX_PHONE_HEADER)} parent={section.startsWith('team-') && activeTeam ? activeTeam.name : undefined} title={section === 'coordinator' ? chatTitle : sectionTitles[section]} heading={chatHeading} actions={<>{section === 'suggestions' && <SuggestionsRefresh />}{section === 'plugins' || section === 'artifacts' || FRAME_OWNS_HEADER ? null : <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText("Workspace.openSearch")} aria-keyshortcuts="Control+k Meta+k" disabled={boardBusy} onClick={() => setSearchOpen(true)} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText("Workspace.search.title")}<ShortcutKeys keys={['mod', 'K']} /></TooltipContent></Tooltip>}{/* The phone's way to 全部线程; the window bar's is hidden there. */}{!FRAME_OWNS_HEADER && <AllThreadsToggle open={!!threadsView} waiting={threadsWaiting} pending={tasksPending} onToggle={() => toggleAllThreads(!threadsView)} />}</>}>
      {accountError && <FieldError className="px-6 py-2">{accountError}</FieldError>}
      {selected ? <TaskDetail key={draftKey} id={selected} thread={threadsView ? null : threadId} origin={originLabel} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} onDeleted={deleted} onOpen={id => open(id)} navigation={{ index: pagerIndex, total: filtered.length, onOpen: offset => { const index = filtered.findIndex(task => task.id === selected); const next = filtered[index + offset]; if (index >= 0 && next) open(next.id) } }} /> : isProjects ? <ProjectWorkspace projects={scopedProjects} loading={projectsLoading} error={!!projectError} projectId={projectId} team={section === 'team-projects' ? activeTeam?.name : undefined} initialTeamId={section === 'team-projects' ? teamId ?? undefined : undefined} issues={tasks} workspace={workspaceReadError ? undefined : workspaceData} onSelect={id => { setProjectId(id); move({ project: id }) }} onOpenTeam={() => { navigateSection('team-projects') }} onOpenIssue={openFromList} onCreateIssue={() => create()} onUpdated={() => { void refreshProjects(); void refreshProjectTeams() }} /> : section === 'team-home' && activeTeam ? <TeamHome key={activeTeam.id} team={activeTeam} projects={scopedProjects} issueCount={counts.all} onIssues={() => navigate('all')} onProjects={() => navigateSection('team-projects')} onProject={id => { void leave(() => { applySelection(null); move({ ...changeSection('team-projects'), issue: null, project: id }); setProjectId(id) }) }} /> : section === 'group' && groupRequest ? <GroupChatView key={groupRequest.id} group={groupRequest} userId={user.id} people={groupPeople} /> : section === 'group' && groupId && !groupList ? <DetailLoading /> :isOverview ? <ConversationPanels.Provider key={conversationScope} value={conversationPanels}><WorkspaceOverview section={section} teamName={activeTeam?.name} counts={counts} projectCount={scopedProjects.length} tasks={scopedTasks} userId={user.id} initialAgentHistory={initialAgentHistory} agentRequest={agentRequest} onAgentActive={setActiveAgentId} onAgentSessions={setLiveSessions} bot={activeBot} onOpen={id => open(id)} onProjects={() => navigateSection('team-projects')} onView={navigate} /></ConversationPanels.Provider> : section === 'plugins' ? <PluginsPage key={pluginsVisit} /> : section === 'suggestions' ? <InboxPage threads={threads} issues={tasks} onOpenIssue={id => { open(id) }} onConnect={() => openRail('plugins')} onSent={() => { if (window.matchMedia('(max-width: 767px)').matches) openChat({ kind: 'coordinator' }) }} /> : section === 'artifacts' ? <ArtifactsPage issues={tasks} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} ownerId={user.id} /> : section === 'memory' ? <MemoryPage /> : section === 'tasks' ? <TasksPage threads={threads} issues={tasks} onOpenIssue={id => { open(id) }} onCreate={() => create()} onOpenInbox={() => navigateSection('suggestions')} /> : tasksLoading ? <DetailLoading /> : layout === 'board' ? <BoardPage teamId={section.startsWith('team-') ? teamId ?? undefined : undefined} workspaceId={workspaceContext?.workspace.id ?? workspaceData?.workspace.id} personalWorkspace={(workspaceContext?.workspace ?? workspaceData?.workspace)?.kind === 'personal'} stateKey={`board:${section}:${teamId ?? "all"}`} issues={filtered} userId={user.id} onOpen={openFromList} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-sm font-semibold">{section === 'my-issues' ? i18nText("Workspace.myCreatedTasks") : viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge>{section !== 'my-issues' && <NativeSelect aria-label={i18nText("Workspace.filterStatus")} value={view} disabled={boardBusy} onChange={event => navigate(event.target.value as IssueView)}><NativeSelectOption value="all">{i18nText("Projects.allStatuses")}</NativeSelectOption><NativeSelectOption value="favorites">{i18nText("Overview.favorites")}</NativeSelectOption><NativeSelectOption value="following">{i18nText("Overview.following")}</NativeSelectOption>{ISSUE_STATUSES.map(status => <NativeSelectOption key={status.value} value={status.value}>{statusLabel(status.value)}</NativeSelectOption>)}</NativeSelect>}</div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><SearchInput className="min-w-0 sm:w-48" aria-label={i18nText("Workspace.search.title")} placeholder={i18nText("Projects.issuePicker.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /><ToggleGroup aria-label={i18nText("Workspace.taskView")} size="sm" variant="segment" spacing={0.5} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label={i18nText("Workspace.listView")}><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label={i18nText("Workspace.boardView")}><Columns3 /></ToggleGroupItem></ToggleGroup><Button size="sm" disabled={boardBusy} onClick={() => create()}><Plus data-icon="inline-start" />{i18nText("Nav.newTask")}</Button></div>
        </div>
        <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={openFromList} onCreate={() => create()} />
      </>}
      {!selected && paging.hasMore && (section === 'tasks' || section === 'all-issues' || section === 'my-issues' || section === 'team-issues' || threadsView) &&
        <div className="flex shrink-0 justify-center p-2">
          <Button variant="ghost" size="sm" disabled={paging.loading} onClick={() => void paging.loadMore()}>
            {paging.failed ? i18nText('Common.retry') : i18nText('HostedTasks.loadMore')}
          </Button>
        </div>}
    </AppShellContent>
    {browserShown && !threadShown && !threadsView && !panelsInFrame && <BrowserPane onClose={() => showBrowser(false)} />}
    {threadShown && <ThreadColumn runId={threadShown} issueId={shownThread?.issueId} overList={!!threadsView} name={shownThread ? threadName(shownThread, tasks, '') : undefined} />}
    {taskShown && !threadShown && <TaskColumn issueId={taskShown} issue={tasks.find(task => task.id === taskShown)} threads={threads} overList={!!threadsView}>
      <EmbeddedTaskDetail key={taskShown} issueId={taskShown} origin={originLabel} onOpenTask={id => open(id)} onClose={closeTask} />
    </TaskColumn>}
    {threadsView && !threadShown && !taskShown && <AllThreadsColumn view={threadsView} threads={threads} issues={tasks} loading={threadsLoading} />}
    {/* Opening, closing and handing the column to a thread are instant (R-37). */}
    {isConversation && !panelsInFrame && panelOpen && !rightTaken && <ContextPanel key="context-panel" workspaceId={workspaceData?.workspace.id} issues={tasks} threads={threads} threadsLoading={threadsLoading} onOpenThread={thread => openThread(thread.runId)} onClose={() => showPanel(false)}
      conversation={activeBot ? { id: activeBot.id, name: activeBot.name, color: activeBot.color, shape: activeBot.shape, kind: 'bot' } : { id: coordinatorBot?.id, name: i18nText('Nav.coordinator'), kind: 'coordinator', updatedAt: coordinatorUpdatedAt }} />}
    {groupPanel && panelOpen && !rightTaken && <GroupPanel key={`group-panel:${groupPanel.id}`} group={groupPanel} onClose={() => showPanel(false)} />}
    {groupPanel && !rightTaken && <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
      <SheetContent side="right" instant showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full sm:max-w-sm">
        <SheetHeader className="sr-only"><SheetTitle>{i18nText('Shell.panel.label')}</SheetTitle></SheetHeader>
        <GroupPanel sheet group={groupPanel} onClose={() => setPanelSheet(false)} />
      </SheetContent>
    </Sheet>}
    {isConversation && !panelsInFrame && !rightTaken && <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
      <SheetContent side="right" instant showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full sm:max-w-sm">
        <SheetHeader className="sr-only"><SheetTitle>{i18nText('Shell.panel.label')}</SheetTitle></SheetHeader>
        <ContextPanel sheet workspaceId={workspaceData?.workspace.id} issues={tasks} threads={threads} threadsLoading={threadsLoading} onOpenThread={thread => { setPanelSheet(false); openThread(thread.runId) }} onOpenTask={() => setPanelSheet(false)} onClose={() => setPanelSheet(false)}
      conversation={activeBot ? { id: activeBot.id, name: activeBot.name, color: activeBot.color, shape: activeBot.shape, kind: 'bot' } : { id: coordinatorBot?.id, name: i18nText('Nav.coordinator'), kind: 'coordinator', updatedAt: coordinatorUpdatedAt }} />
      </SheetContent>
    </Sheet>}
    {/* One place shows the Artifact window, from the address, whichever entry opened it (R-56, R-82). */}
    {artifactId && <ArtifactWindow artifactId={artifactId} />}
    </>}
    {dialogs}
  </AppFrame>}</BrowserNotesProvider></ComputerAgentsProvider></EmbeddedTaskLifecycle></SignOutBoundary></TaskCardDataProvider></TaskPresentationsContext>
}
