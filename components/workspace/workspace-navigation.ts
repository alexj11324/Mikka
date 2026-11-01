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
export type WorkspaceSection = 'inbox' | 'my-issues' | 'agent' | 'coordinator' | 'group' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues' | 'plugins' | 'suggestions' | 'artifacts'

export const SECTION_TITLE_KEYS: Record<WorkspaceSection, string> = {
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
}

/** Sections a reload or a shared link reopens; the others start from their parent page. The Coordinator's chat is the default and needs none. */
const URL_SECTIONS = ['agent', 'plugins', 'suggestions', 'artifacts', 'all-issues', 'projects'] as const satisfies readonly WorkspaceSection[]
const READ_SECTIONS: readonly string[] = [...URL_SECTIONS, 'coordinator']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Query keys that belong to a page inside a section (the plugins page's app and category); a new place drops them. */
const PAGE_KEYS = ['app', 'category'] as const

export function sectionFromQuery(section: string | undefined): WorkspaceSection {
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
  /** The thread (its run id) open in the right column, beside whatever is in the centre (R-82). */
  thread: string | null
  /** The Artifact open in its window over the page (R-56, R-82). */
  artifact: string | null
}

/** Team pages, under 看板 (R-82); each needs its team. */
const TEAM_SECTIONS: readonly string[] = ['team-home', 'team-issues', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Pages that can show one project. */
const PROJECT_SECTIONS: readonly string[] = ['projects', 'team-projects'] satisfies readonly WorkspaceSection[]
/** Keys this file owns besides `section`, in the order a new address writes them. */
const PLACE_KEYS = ['bot', 'group', 'session', 'team', 'project', 'issue', 'thread', 'artifact'] as const satisfies readonly (keyof WorkspaceLocation)[]
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
    thread: id('thread'),
    artifact: id('artifact'),
  }
}

export function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation) {
  return a.section === b.section && PLACE_KEYS.every(key => a[key] === b[key])
}

/** The address with `change` applied to `current`; query keys this file does not own are kept. */
export function workspaceHref(current: URL, change: Partial<WorkspaceLocation>): string {
  const url = new URL(current.href)
  const params = url.searchParams
  const before = readLocation(params)
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
  // The Artifact window sits over the page it was opened from: another place, or another thread, closes it unless the move names one.
  if ((centreMoved || next.thread !== before.thread) && !('artifact' in change)) next.artifact = null
  if (next.section !== before.section || next.bot !== before.bot) for (const key of PAGE_KEYS) params.delete(key)
  writeSectionQuery(params, next.section)
  if (next.team && next.section !== 'team-home') params.set('section', next.section)
  for (const key of PLACE_KEYS) {
    const value = next[key]
    if (value) params.set(key, value)
    else params.delete(key)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

/** The query for a place, built from nothing (a link to copy, a notification, a server redirect). */
export function workspaceSearch(place: Partial<WorkspaceLocation>): string {
  const href = workspaceHref(new URL('https://mikka.invalid/'), place)
  return href.slice(1)
}

/** An app-root link to a place, e.g. `/?issue=<id>`; prefix the base path and locale where the caller needs them. */
export function workspaceLink(place: Partial<WorkspaceLocation>): string {
  return `/${workspaceSearch(place)}`
}

/** The query the workspace last wrote or showed; see queryMoved. */
let seenQuery: string | null = null

function write(href: string, mode: 'push' | 'replace') {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (href !== current) {
    if (mode === 'push') window.history.pushState(window.history.state, '', href)
    else window.history.replaceState(window.history.state, '', href)
  }
  seenQuery = window.location.search
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
export function goTo(change: Partial<WorkspaceLocation>, mode: 'push' | 'replace' = 'push') {
  write(workspaceHref(new URL(window.location.href), change), mode)
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
  goTo(change, mode)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

/** Opens a thread in the right column beside what is in the centre (R-82). */
export function openThread(runId: string) {
  navigate({ thread: runId })
}

/** Closes the open thread; the right column shows 概览 again. */
export function closeThread() {
  navigate({ thread: null })
}

/** Opens an Artifact in its window over the page (R-56); the centre and the thread under it stay. */
export function openArtifact(id: string) {
  navigate({ artifact: id })
}

/** Closes the Artifact window; the page under it is as it was. */
export function closeArtifact() {
  navigate({ artifact: null })
}
