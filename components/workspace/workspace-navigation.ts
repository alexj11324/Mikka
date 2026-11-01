import { pushSettingsHistory } from '@/lib/settings-navigation'

/**
 * The workspace's address. One URL describes what is on screen, and every
 * change a person makes goes through here, so the browser's back and forward
 * step through it one place at a time (rules.md R-80,
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
  /** The task open in the centre. */
  issue: string | null
  /** The thread (its run id) open in the right column, beside whatever is in the centre (R-80). */
  thread: string | null
}

export function readLocation(params: URLSearchParams): WorkspaceLocation {
  const section = sectionFromQuery(params.get('section') ?? undefined)
  const bot = params.get('bot')
  const issue = params.get('issue')
  const thread = params.get('thread')
  return {
    section,
    bot: section === 'coordinator' && bot && UUID.test(bot) ? bot : null,
    issue: issue && UUID.test(issue) ? issue : null,
    thread: thread && UUID.test(thread) ? thread : null,
  }
}

export function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation) {
  return a.section === b.section && a.bot === b.bot && a.issue === b.issue && a.thread === b.thread
}

/** The address with `change` applied to `current`; query keys this file does not own are kept. */
export function workspaceHref(current: URL, change: Partial<WorkspaceLocation>): string {
  const url = new URL(current.href)
  const params = url.searchParams
  const before = readLocation(params)
  const next = { ...before, ...change }
  if (next.section !== 'coordinator') next.bot = null
  const centreMoved = next.section !== before.section || next.bot !== before.bot || next.issue !== before.issue
  // A thread sits beside the centre it was opened from; a new centre closes it unless the move names one.
  if (centreMoved && !('thread' in change)) next.thread = null
  if (next.section !== before.section || next.bot !== before.bot) for (const key of PAGE_KEYS) params.delete(key)
  writeSectionQuery(params, next.section)
  if (next.bot) params.set('bot', next.bot)
  else params.delete('bot')
  if (next.issue) params.set('issue', next.issue)
  else params.delete('issue')
  if (next.thread) params.set('thread', next.thread)
  else params.delete('thread')
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

/** Opens a thread in the right column beside what is in the centre (R-80). */
export function openThread(runId: string) {
  navigate({ thread: runId })
}

/** Closes the open thread; the right column shows 概览 again. */
export function closeThread() {
  navigate({ thread: null })
}
