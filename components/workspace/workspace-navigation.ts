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
  /** The task open in the centre. */
  issue: string | null
  /** The thread (its run id) open in the right column, beside whatever is in the centre (R-82). */
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
  if (next.section !== 'coordinator') next.bot = null
  const centreMoved = next.section !== before.section || next.bot !== before.bot || next.issue !== before.issue
  // A thread sits beside the centre it was opened from; a new centre closes it unless the move names one.
  if (centreMoved && !('thread' in change)) next.thread = null
  if (next.section !== before.section || next.bot !== before.bot) for (const key of PAGE_KEYS) params.delete(key)
  // A task opened from the Coordinator's chat says so (a bare `?issue=` is a plain link), so ✕ and its first crumb return there.
  // A team page has no section of its own in the address and reads as the Coordinator, so it names none.
  if (next.issue && next.section === 'coordinator' && !next.bot && (named || (nameCoordinator && !before.issue && !params.has('team')))) params.set('section', 'coordinator')
  else writeSectionQuery(params, next.section)
  if (next.bot) params.set('bot', next.bot)
  else params.delete('bot')
  if (next.issue) params.set('issue', next.issue)
  else params.delete('issue')
  if (next.thread) params.set('thread', next.thread)
  else params.delete('thread')
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

function write(href: string, mode: 'push' | 'replace', list = false) {
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (href !== current) {
    const issue = (url: URL) => readLocation(url.searchParams).issue
    const mark = nextMark(readMark(window.history.state), issue(new URL(window.location.href)), issue(new URL(href, window.location.href)), mode, DOC, list)
    const state = { ...window.history.state, [MARK]: mark }
    if (mode === 'push') window.history.pushState(state, '', href)
    else window.history.replaceState(state, '', href)
  }
  seenQuery = window.location.search
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
