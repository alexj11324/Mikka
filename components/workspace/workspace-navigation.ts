import { pushSettingsHistory } from '@/lib/settings-navigation'

/**
 * The workspace's address. One URL describes what is on screen, and every
 * change a person makes goes through here, so the browser's back and forward
 * step through it one place at a time (rules.md R-82,
 * decisions/2026-11-01-1320-navigation-model.md).
 *
 * Nothing outside this file and lib/settings-navigation.ts writes the
 * browser history; scripts/navigation-policy.mjs enforces that.
 */
export type WorkspaceSection = 'conversations' | 'inbox' | 'my-issues' | 'agent' | 'coordinator' | 'group' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues' | 'plugins' | 'suggestions' | 'artifacts' | 'memory'

export const SECTION_TITLE_KEYS: Record<WorkspaceSection, string> = {
  conversations: 'Nav.conversations',
  inbox: 'Nav.inbox',
  'my-issues': 'Nav.myTasks',
  agent: 'Nav.agent',
  coordinator: 'Nav.coordinator',
  group: 'GroupChat.untitled',
  projects: 'Nav.projects',
  views: 'Nav.views',
  'team-home': 'Nav.teamHome',
  'team-issues': 'Nav.tasks',
  'team-projects': 'Nav.projects',
  'all-issues': 'Nav.allIssues',
  plugins: 'Nav.plugins',
  suggestions: 'Nav.suggestions',
  artifacts: 'Nav.artifacts',
  memory: 'HostedSettings.memory.title',
}

/** Sections a reload or a shared link reopens; the others start from their parent page. The Coordinator's chat is the default and needs none. */
const URL_SECTIONS = ['conversations', 'agent', 'plugins', 'suggestions', 'artifacts', 'memory', 'all-issues', 'projects'] as const satisfies readonly WorkspaceSection[]
const READ_SECTIONS: readonly string[] = [...URL_SECTIONS, 'coordinator']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Query keys that belong to a page inside a section (the plugins page's app and category); a new place drops them. */
const PAGE_KEYS = ['app', 'category'] as const

/** The retired 任务 page's address. Tasks have one entry, the board (2026-11-13-1405): an old link opens it in its list view. */
export const LEGACY_TASKS_SECTION = 'tasks'

export function sectionFromQuery(section: string | undefined): WorkspaceSection {
  if (section === LEGACY_TASKS_SECTION) return 'all-issues'
  return READ_SECTIONS.includes(section ?? '') ? section as WorkspaceSection : 'coordinator'
}

export function writeSectionQuery(params: URLSearchParams, section: WorkspaceSection): void {
  if (URL_SECTIONS.some(item => item === section)) params.set('section', section)
  else params.delete('section')
}

/** What the address says is on screen. */
export type WorkspaceLocation = {
  section: WorkspaceSection
  /** The bot whose chat is in the centre; null for the Coordinator. */
  bot: string | null
  /** The group chat in the centre (`group=<id>`; its section is implied). */
  group: string | null
  /** The saved chat in the centre (`section=agent&session=<id>`); null opens the latest. */
  session: string | null
  /** The team whose page is in the centre; its 主页 is `team=<id>` alone. */
  team: string | null
  /** The project open on the projects page. */
  project: string | null
  /** The task open in the centre. */
  issue: string | null
  /** The task open in the right column, beside whatever is in the centre (decision 2026-11-07-2045): a thread opened from it sits over it, and ← comes back to it. */
  task: string | null
  /** The thread (its run id) open in the right column, beside whatever is in the centre (R-82). */
  thread: string | null
  /** The Artifact open in its window over the page (R-56, R-82). */
  artifact: string | null
  /** 全部线程 in the right column: 'all', or one bot's id when filtered to it. It stays open as the centre changes. */
  threads: string | null
}

/** Team pages, under 看板 (R-82); each needs its team. */
const TEAM_SECTIONS: readonly string[] = ['team-home', 'team-issues', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Pages that can show one project. */
const PROJECT_SECTIONS: readonly string[] = ['projects', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Keys this file owns besides `section`, in the order a new address writes them. */
const PLACE_KEYS = ['bot', 'group', 'session', 'team', 'project', 'issue', 'task', 'thread', 'artifact', 'threads'] as const satisfies readonly (keyof WorkspaceLocation)[]
/** What is in the centre; the thread sits beside it and the Artifact window over it. */
const CENTRE_KEYS = ['section', 'bot', 'group', 'session', 'team', 'project', 'issue'] as const satisfies readonly (keyof WorkspaceLocation)[]

/** A team page without a team is the workspace-wide page it would scope. */
export function sectionFor(section: WorkspaceSection, team: string | null): WorkspaceSection {
  if (!TEAM_SECTIONS.includes(section) || team) return section
  return section === 'team-projects' ? 'projects' : section === 'team-issues' ? 'all-issues' : 'coordinator'
}

export function readLocation(params: URLSearchParams): WorkspaceLocation {
  const id = (key: string) => { const value = params.get(key); return value && UUID.test(value) ? value : null }
  const asked = params.get('section') ?? undefined
  const team = id('team')
  let section = sectionFromQuery(asked)
  if (team && (asked === undefined || TEAM_SECTIONS.includes(asked))) section = (asked ?? 'team-home') as WorkspaceSection
  else if (section === 'coordinator' && id('group')) section = 'group'
  return {
    section,
    bot: section === 'coordinator' ? id('bot') : null,
    group: section === 'group' ? id('group') : null,
    session: section === 'agent' ? id('session') : null,
    team: TEAM_SECTIONS.includes(section) ? team : null,
    project: PROJECT_SECTIONS.includes(section) ? id('project') : null,
    issue: id('issue'),
    task: id('task'),
    thread: id('thread'),
    artifact: id('artifact'),
    threads: params.get('threads') === 'all' ? 'all' : id('threads'),
  }
}

export function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation) {
  return a.section === b.section && PLACE_KEYS.every(key => a[key] === b[key])
}

/**
 * Where a task page was opened from, when its address names it: a bot's chat
 * (`bot=`), the Coordinator's chat (`section=coordinator`), the board or
 * another page (`section=`). Null for a bare `?issue=` link.
 */
export type TaskOrigin = { section: WorkspaceSection; bot: string | null }

export function taskOrigin(params: URLSearchParams): TaskOrigin | null {
  const location = readLocation(params)
  if (location.bot) return { section: 'coordinator', bot: location.bot }
  return READ_SECTIONS.includes(params.get('section') ?? '') ? { section: location.section, bot: null } : null
}

function buildHref(current: URL, change: Partial<WorkspaceLocation>, nameCoordinator: boolean): string {
  const url = new URL(current.href)
  const params = url.searchParams
  const before = readLocation(params)
  const named = params.get('section') === 'coordinator'
  const next = { ...before, ...change }
  next.section = sectionFor(next.section, next.team)
  if (next.section !== 'coordinator') next.bot = null
  if (next.section !== 'group') next.group = null
  if (next.section !== 'agent') next.session = null
  if (!TEAM_SECTIONS.includes(next.section)) next.team = null
  if (!PROJECT_SECTIONS.includes(next.section)) next.project = null
  const centreMoved = CENTRE_KEYS.some(key => next[key] !== before[key])
  // A thread sits beside the centre it was opened from; a new centre closes it unless the move names one.
  if (centreMoved && !('thread' in change)) next.thread = null
  // So does a task opened beside it.
  if (centreMoved && !('task' in change)) next.task = null
  // The Artifact window sits over the page it was opened from: another place, or another thread, closes it unless the move names one.
  if ((centreMoved || next.thread !== before.thread) && !('artifact' in change)) next.artifact = null
  if (next.section !== before.section || next.bot !== before.bot) for (const key of PAGE_KEYS) params.delete(key)
  // A task opened from the Coordinator's chat says so (a bare `?issue=` is a plain link), so ✕ and its first crumb return there.
  // A team page reads as its team, so it names no chat.
  if (next.issue && next.section === 'coordinator' && !next.bot && (named || (nameCoordinator && !before.issue && !next.team))) params.set('section', 'coordinator')
  else writeSectionQuery(params, next.section)
  if (next.team && next.section !== 'team-home') params.set('section', next.section)
  for (const key of PLACE_KEYS) {
    const value = next[key]
    if (value) params.set(key, value)
    else params.delete(key)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

/** The address with `change` applied to `current`; query keys this file does not own are kept. */
export function workspaceHref(current: URL, change: Partial<WorkspaceLocation>): string {
  return buildHref(current, change, true)
}

/** The query for a place, built from nothing (a link to copy, a notification, a server redirect). */
export function workspaceSearch(place: Partial<WorkspaceLocation>): string {
  const href = buildHref(new URL('https://mikka.invalid/'), place, place.section === 'coordinator')
  return href.slice(1)
}

export function openGroupConversation(id: string) {
  navigate({ section: 'group', group: id, issue: null, thread: null, task: null })
}

/** An app-root link to a place, e.g. `/?issue=<id>`; prefix the base path and locale where the caller needs them. */
export function workspaceLink(place: Partial<WorkspaceLocation>): string {
  return `/${workspaceSearch(place)}`
}

/**
 * The address as the workspace shows it: an unknown `section`, a `bot` that
 * is not one of the person's bots (`botExists`, once the list has loaded) and
 * keys that are not ids drop out.
 */
export function canonicalHref(current: URL, botExists?: (id: string) => boolean): string {
  const location = readLocation(current.searchParams)
  if (location.bot && botExists && !botExists(location.bot)) location.bot = null
  return workspaceHref(current, location)
}

/**
 * Each entry the workspace writes carries a mark in history.state beside
 * Next's own keys (`__NA`, `__PRIVATE_NEXTJS_INTERNALS_TREE`, copied, never
 * replaced): its position and, on a task page, the entry that opened it. ✕
 * steps back there when that entry belongs to this page load (`doc`), so the
 * chat comes back as it was; a pasted link, a reload or a cold start has no
 * such entry and goes to the address's origin instead.
 */
export type EntryMark = { index: number; task: { start: number; doc: string; list: boolean } | null }
const MARK = 'mikkaEntry'

export function readMark(state: unknown): EntryMark | null {
  const mark = state && typeof state === 'object' ? (state as Record<string, unknown>)[MARK] : null
  if (!mark || typeof mark !== 'object') return null
  const { index, task } = mark as Partial<EntryMark>
  if (typeof index !== 'number') return null
  return { index, task: task && typeof task.start === 'number' && typeof task.doc === 'string' ? { start: task.start, doc: task.doc, list: task.list === true } : null }
}

/** The mark for the entry written after `previous`. A task opened from a place starts its own; a move inside it (a thread, ↑↓, a sub-task) keeps the one it started with. */
export function nextMark(previous: EntryMark | null, from: string | null, to: string | null, mode: 'push' | 'replace', doc: string, list: boolean): EntryMark {
  const base = previous ?? { index: 0, task: null }
  const index = mode === 'push' ? base.index + 1 : base.index
  if (!to) return { index, task: null }
  if (from) return { index, task: base.task }
  return { index, task: { start: index, doc, list } }
}

/** How many entries back the place that opened this task is, in this page load; 0 when it was opened directly. */
export function stepsToOrigin(mark: EntryMark | null, doc: string): number {
  const task = mark?.task
  return mark && task && task.doc === doc && task.start >= 1 ? mark.index - task.start + 1 : 0
}

/** This page load: a mark left by an earlier one (before a reload) does not count as a way back. */
const DOC = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** The query the workspace last wrote or showed; see queryMoved. */
let seenQuery: string | null = null

/** The entry openThread pushed: the thread it opened and the address it was opened from. */
type OpenedThread = { runId: string; from: string }
const OPENED = 'mikkaOpenedThread'
/** The entry openTask pushed: the task it opened and the address it was opened from. */
type OpenedTask = { issueId: string; from: string }
const OPENED_TASK = 'mikkaOpenedTask'

const WORK_TAB = 'mikkaWorkTab'
export function workTabForEntry(scope: string) {
  const saved = window.history.state?.[WORK_TAB]
  if (saved?.scope !== scope || saved.href !== here()) return null
  return workTab(saved.tab)
}

function workTab(tab: unknown): { kind: 'task' | 'thread'; id: string } | null {
  if (typeof tab !== 'string') return null
  const [kind, id, extra] = tab.split(':')
  return (kind === 'task' || kind === 'thread') && UUID.test(id) && extra === undefined ? { kind, id } : null
}

/** Keep only the active work tab in this chat's browser entry. Its content is read afresh on restore. */
export function rememberWorkTab(scope: string, tab: string | null) {
  const state = { ...window.history.state }
  if (workTab(tab)) state[WORK_TAB] = { scope, tab, href: here() }
  else if (state[WORK_TAB]?.scope === scope) delete state[WORK_TAB]
  else return
  window.history.replaceState(state, '', here())
}

function write(href: string, mode: 'push' | 'replace', list = false) {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  // A no-op tidy during the router's render has not shown a restored address.
  // Its pending popstate must still update the workspace's selection.
  if (href !== current) {
    const issue = (url: URL) => readLocation(url.searchParams).issue
    const mark = nextMark(readMark(window.history.state), issue(new URL(window.location.href)), issue(new URL(href, window.location.href)), mode, DOC, list)
    const state: Record<string, unknown> = { ...window.history.state, [MARK]: mark }
    // Only the entry openThread wrote says where its thread came from; a later entry (an Artifact over it) must not inherit it, or ← would step back onto that entry.
    if (mode === 'push') { delete state[OPENED]; delete state[WORK_TAB] }
    if (mode === 'push') window.history.pushState(state, '', href)
    else window.history.replaceState(state, '', href)
    seenQuery = window.location.search
  }
}

/** True when the task on screen was opened from a list (the board, a list, a project): its ↑↓ step through that list. */
export function openedFromList(): boolean {
  return typeof window !== 'undefined' && readMark(window.history.state)?.task?.list === true
}

/**
 * ✕ on a task page opened by a move in this page load: back to that place, as
 * it was (its open thread too). False when the task was opened directly; the
 * caller then goes to the address's origin.
 */
export function backToTaskOrigin(): boolean {
  const steps = stepsToOrigin(readMark(window.history.state), DOC)
  if (steps < 1) return false
  window.history.go(-steps)
  return true
}

/**
 * True when the query changed since the workspace last wrote or showed one, and
 * marks the current one seen. An in-page #anchor fires popstate too, without
 * moving anywhere. Kept outside React: Next's own popstate handler may render
 * the workspace before the workspace's listener runs.
 */
export function queryMoved(): boolean {
  const now = window.location.search
  const moved = seenQuery !== now
  seenQuery = now
  return moved
}

/**
 * A move the person made (a bot, a rail page, a task): a new history entry.
 * A refinement of the same place (a filter, a cleaned-up one-shot parameter): `replace`.
 */
export function goTo(change: Partial<WorkspaceLocation>, mode: 'push' | 'replace' = 'push', options: { list?: boolean } = {}) {
  write(workspaceHref(new URL(window.location.href), change), mode, options.list)
}

/** Rewrites an invalid or stale address to what is shown, without a new entry. */
export function tidyAddress(botExists?: (id: string) => boolean) {
  write(canonicalHref(new URL(window.location.href), botExists), 'replace')
}

/** A page inside a section (the plugins page's app and category) writes its own keys here. */
export function goToHref(href: string, mode: 'push' | 'replace' = 'push') {
  const url = new URL(href, window.location.href)
  if (url.origin !== window.location.origin) throw new Error('goToHref only moves within the app')
  write(`${url.pathname}${url.search}${url.hash}`, mode)
}

/** Drops one-shot callback keys (?linear=, ?settings=) from the address without a new entry. */
export function dropQueryKeys(...keys: string[]) {
  const url = new URL(window.location.href)
  if (!keys.some(key => url.searchParams.has(key))) return
  for (const key of keys) url.searchParams.delete(key)
  write(`${url.pathname}${url.search}${url.hash}`, 'replace')
}

/**
 * Opens an app link such as `/?issue=<id>` from outside the workspace's own
 * clicks (a desktop notification): a new history entry, then the same
 * back/forward path shows it, from the workspace or from Settings.
 * False when the link is not a place in the app's window.
 */
export function openAppLink(href: string): boolean {
  if (!pushSettingsHistory(href)) return false
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  return true
}

/** The workspace listens for this and shows the address it was just given. */
export const NAVIGATE_EVENT = 'mikka:navigate'

/**
 * A move made from inside a component (a thread card, a chip, a row in the
 * right column): writes the address, then the workspace shows it, with the same
 * unsaved-changes check as back and forward.
 */
export function navigate(change: Partial<WorkspaceLocation>, mode: 'push' | 'replace' = 'push') {
  if (toWorkArea(change)) return
  goTo(change, mode)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/**
 * A chat's work area (the hosted chat, FRAME_OWNS_PANEL; decision 2026-11-10), while that chat is on screen: a task or
 * a thread opened from anywhere on the page opens as one of its tabs instead of a right column beside the chat.
 */
export type WorkAreaOpener = { task: (issueId: string) => void; thread: (runId: string) => void }
let workArea: WorkAreaOpener | null = null

/** The chat on screen hands over its work area; the returned function takes it back (on unmount). */
export function setWorkAreaOpener(opener: WorkAreaOpener): () => void {
  workArea = opener
  return () => { if (workArea === opener) workArea = null }
}

/** A move that only opens a task or a thread beside the centre goes to the chat's work area when there is one. */
function toWorkArea(change: Partial<WorkspaceLocation>): boolean {
  if (!workArea || !Object.keys(change).every(key => key === 'task' || key === 'thread')) return false
  if (change.thread) workArea.thread(change.thread)
  else if (change.task) workArea.task(change.task)
  else return false
  return true
}

function here() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

/** Remember the confirmed Task for this opaque mobile history entry without putting its coordinates in the URL. */
export function rememberMobileTask(task: { server: string; ref: string; target: string; workspaceId: string; userId: string }) {
  window.history.replaceState({ ...window.history.state, mobileTask: task }, '', here())
}

/** Opens a thread in the right column beside what is in the centre (R-82), or in the chat's work area (setWorkAreaOpener). */
export function openThread(runId: string) {
  if (toWorkArea({ thread: runId })) return
  const from = here()
  goTo({ thread: runId })
  // Remembers where it came from, so ← steps back to that list as the browser's back does.
  window.history.replaceState({ ...window.history.state, [OPENED]: { runId, from } satisfies OpenedThread }, '', here())
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/**
 * ← in an open thread: back to the list it was opened from (全部线程, the bot's
 * 线程, the chat), the same step as the browser's back. A thread opened from
 * its address alone has no step to go back to, so its list replaces it.
 */
export function closeThread() {
  const opened = (window.history.state as Record<string, unknown> | null)?.[OPENED] as OpenedThread | undefined
  const current = readLocation(new URL(window.location.href).searchParams).thread
  if (opened && opened.runId === current && opened.from === workspaceHref(new URL(window.location.href), { thread: null })) {
    window.history.back()
    return
  }
  navigate({ thread: null }, 'replace')
}

/** Opens 全部线程 in the right column, or closes it with any task or thread open over it. */
export function toggleAllThreads(open: boolean) {
  navigate(open ? { threads: 'all', task: null, thread: null } : { threads: null, task: null, thread: null })
}

/**
 * Opens a task in the right column beside what is in the centre (decision
 * 2026-11-07-2045): lists show tasks, and a thread is reached from inside its
 * task. ← in the task steps back to where it was opened, as a thread's does.
 */
export function openTask(issueId: string) {
  if (toWorkArea({ task: issueId })) return
  const from = here()
  goTo({ task: issueId, thread: null })
  window.history.replaceState({ ...window.history.state, [OPENED_TASK]: { issueId, from } satisfies OpenedTask }, '', here())
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/** ← or ✕ in a task in the right column: back to the list it was opened from, or its list when opened from its address. */
export function closeTask() {
  const opened = (window.history.state as Record<string, unknown> | null)?.[OPENED_TASK] as OpenedTask | undefined
  const current = readLocation(new URL(window.location.href).searchParams).task
  if (opened && opened.issueId === current && opened.from === workspaceHref(new URL(window.location.href), { task: null, thread: null })) {
    window.history.back()
    return
  }
  navigate({ task: null, thread: null }, 'replace')
}

/** Opens an Artifact in its window over the page (R-56); the centre and the thread under it stay. */
export function openArtifact(id: string) {
  navigate({ artifact: id })
}

/** Closes the Artifact window; the page under it is as it was. */
export function closeArtifact() {
  navigate({ artifact: null })
}
