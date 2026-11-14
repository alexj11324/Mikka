import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalHref, closeThread, goTo, navigate, nextMark, openTask, openThread, setWorkAreaOpener, workTabForEntry, rememberWorkTab, queryMoved, readLocation, readMark, sameLocation, sectionFor, sectionFromQuery, stepsToOrigin, taskOrigin, tidyAddress, workspaceHref, workspaceLink, workspaceSearch, writeSectionQuery, type EntryMark } from './workspace-navigation'
import type { WorkspaceLocation } from './workspace-navigation'

const BOT = '3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f'
const ISSUE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const RUN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const GROUP = '7c6b5a49-3827-4165-a4b3-c2d1e0f9a8b7'
const TEAM = '1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a'
const PROJECT = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'
const ARTIFACT = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901'
const SESSION = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8'
const at = (path: string) => new URL(`https://app.example${path}`)
const NOWHERE = { bot: null, group: null, session: null, team: null, project: null, issue: null, task: null, thread: null, artifact: null, threads: null }
/** A full place from the keys that are set. */
const place = (keys: Partial<WorkspaceLocation> & Pick<WorkspaceLocation, 'section'>): WorkspaceLocation => ({ ...NOWHERE, ...keys })

test('the task board survives a reload and a shared link', () => {
  const params = new URLSearchParams('bot=b1')
  writeSectionQuery(params, 'all-issues')
  assert.equal(params.toString(), 'bot=b1&section=all-issues')
  assert.equal(sectionFromQuery(params.get('section') ?? undefined), 'all-issues')
})

test('sections without a link of their own drop the section, and so does the Coordinator', () => {
  for (const section of ['team-issues', 'coordinator'] as const) {
    const params = new URLSearchParams('section=all-issues')
    writeSectionQuery(params, section)
    assert.equal(params.toString(), '')
  }
})

test('unknown or missing sections open the chat; older ?section=coordinator links still read', () => {
  assert.equal(sectionFromQuery(undefined), 'coordinator')
  assert.equal(sectionFromQuery('team-home'), 'coordinator')
  assert.equal(sectionFromQuery('projects'), 'projects')
  assert.deepEqual(readLocation(new URLSearchParams(`section=coordinator&bot=${BOT}`)), place({ section: 'coordinator', bot: BOT }))
})

test('an address reads back as the place it was written for', () => {
  for (const where of [
    place({ section: 'coordinator' }),
    place({ section: 'coordinator', bot: BOT }),
    place({ section: 'coordinator', bot: BOT, issue: ISSUE }),
    place({ section: 'coordinator', thread: RUN }),
    place({ section: 'coordinator', bot: BOT, issue: ISSUE, thread: RUN }),
    place({ section: 'all-issues', issue: ISSUE }),
    place({ section: 'artifacts', thread: RUN }),
    place({ section: 'projects' }),
    place({ section: 'group', group: GROUP }),
    place({ section: 'group', group: GROUP, thread: RUN, artifact: ARTIFACT }),
    place({ section: 'agent', session: SESSION }),
    place({ section: 'projects', project: PROJECT }),
    place({ section: 'team-home', team: TEAM }),
    place({ section: 'team-issues', team: TEAM, issue: ISSUE }),
    place({ section: 'team-projects', team: TEAM, project: PROJECT }),
    place({ section: 'coordinator', bot: BOT, artifact: ARTIFACT }),
    place({ section: 'artifacts', artifact: ARTIFACT }),
    place({ section: 'coordinator', threads: 'all' }),
    place({ section: 'all-issues', issue: ISSUE, thread: RUN, threads: BOT }),
  ]) {
    const href = workspaceHref(at('/mikka/zh-CN'), where)
    assert.ok(href.startsWith('/mikka/zh-CN'), href)
    assert.ok(sameLocation(readLocation(new URL(href, 'https://app.example').searchParams), where), href)
  }
})

test('the Coordinator is the bare address; a bot belongs only to the chat', () => {
  assert.equal(workspaceHref(at(`/mikka?bot=${BOT}`), { bot: null }), '/mikka')
  assert.equal(workspaceHref(at(`/mikka?bot=${BOT}`), { section: 'all-issues' }), '/mikka?section=all-issues')
  assert.deepEqual(readLocation(new URLSearchParams(`section=artifacts&bot=${BOT}`)).bot, null)
})

test('a new place drops the plugins page\'s app and category; keys this file does not own stay', () => {
  assert.equal(workspaceHref(at('/mikka?section=plugins&app=gmail&category=mail'), { section: 'all-issues' }), '/mikka?section=all-issues')
  assert.equal(workspaceHref(at('/mikka?section=plugins&app=gmail'), { issue: ISSUE }), `/mikka?section=plugins&app=gmail&issue=${ISSUE}`)
  assert.equal(workspaceHref(at('/mikka?ref=t1&section=all-issues#x'), { issue: ISSUE }), `/mikka?ref=t1&section=all-issues&issue=${ISSUE}#x`)
})

test('ids that are not UUIDs are not places', () => {
  assert.deepEqual(readLocation(new URLSearchParams('issue=../x&bot=nope&artifact=1&group=x&team=y')), place({ section: 'coordinator' }))
})

test('links built from nothing', () => {
  assert.equal(workspaceLink({ issue: ISSUE }), `/?issue=${ISSUE}`)
  assert.equal(workspaceLink({ bot: BOT }), `/?bot=${BOT}`)
  assert.equal(workspaceLink({ section: 'coordinator' }), '/')
  assert.equal(workspaceSearch({ section: 'all-issues' }), '?section=all-issues')
})

test('a thread sits beside its centre: a new centre closes it unless the move names one', () => {
  const chatWithThread = at(`/mikka?bot=${BOT}&thread=${RUN}`)
  assert.equal(workspaceHref(chatWithThread, { section: 'all-issues' }), '/mikka?section=all-issues')
  assert.equal(workspaceHref(chatWithThread, { issue: ISSUE }), `/mikka?bot=${BOT}&issue=${ISSUE}`)
  assert.equal(workspaceHref(chatWithThread, { issue: ISSUE, thread: RUN }), `/mikka?bot=${BOT}&thread=${RUN}&issue=${ISSUE}`)
  assert.equal(workspaceHref(chatWithThread, { thread: null }), `/mikka?bot=${BOT}`)
  assert.equal(workspaceHref(at('/mikka'), { thread: RUN }), `/mikka?thread=${RUN}`)
  assert.equal(readLocation(new URLSearchParams('thread=nope')).thread, null)
})

test('全部线程 stays open as the centre changes; a thread opened over it closes with a new centre', () => {
  const list = at(`/mikka?threads=all&thread=${RUN}`)
  assert.equal(workspaceHref(list, { section: 'all-issues' }), '/mikka?threads=all&section=all-issues')
  assert.equal(workspaceHref(list, { thread: null }), '/mikka?threads=all')
  assert.equal(workspaceHref(at('/mikka?threads=all'), { threads: BOT }), `/mikka?threads=${BOT}`)
  assert.equal(workspaceHref(list, { threads: null, thread: null }), '/mikka')
  assert.equal(readLocation(new URLSearchParams('threads=../x')).threads, null)
  assert.equal(readLocation(new URLSearchParams('threads=all')).threads, 'all')
})

test('an Artifact opens over the page: the centre and the thread stay, and closing it leaves them', () => {
  const chatWithThread = at(`/mikka?bot=${BOT}&thread=${RUN}`)
  const open = workspaceHref(chatWithThread, { artifact: ARTIFACT })
  assert.equal(open, `/mikka?bot=${BOT}&thread=${RUN}&artifact=${ARTIFACT}`)
  assert.equal(workspaceHref(at(open), { artifact: null }), `/mikka?bot=${BOT}&thread=${RUN}`)
  assert.equal(workspaceHref(at(`/mikka?section=artifacts&artifact=${ARTIFACT}`), { artifact: null }), '/mikka?section=artifacts')
  // A task or a thread opened from inside the window replaces what is under it, and the window closes.
  assert.equal(workspaceHref(at(open), { issue: ISSUE }), `/mikka?bot=${BOT}&issue=${ISSUE}`)
  assert.equal(workspaceHref(at(open), { thread: null }), `/mikka?bot=${BOT}`)
  assert.equal(workspaceHref(at(`/mikka?artifact=${ARTIFACT}`), { section: 'all-issues' }), '/mikka?section=all-issues')
})

test('a group chat is `group=<id>`; another chat drops it', () => {
  assert.equal(workspaceLink({ section: 'group', group: GROUP }), `/?group=${GROUP}`)
  assert.deepEqual(readLocation(new URLSearchParams(`group=${GROUP}`)), place({ section: 'group', group: GROUP }))
  assert.equal(workspaceHref(at(`/mikka?group=${GROUP}&thread=${RUN}`), { section: 'coordinator', bot: BOT }), `/mikka?bot=${BOT}`)
  // Another page named next to it wins; the group is not part of it.
  assert.equal(readLocation(new URLSearchParams(`section=all-issues&group=${GROUP}`)).group, null)
})

test('the conversation directory has its own route alongside the default coordinator chat', () => {
  const directory = workspaceLink({ section: 'conversations' })
  assert.equal(directory, '/?section=conversations')
  assert.equal(readLocation(new URL(directory, 'https://example.invalid').searchParams).section, 'conversations')
  assert.equal(readLocation(new URLSearchParams()).section, 'coordinator')
})

test('a saved chat is `section=agent&session=<id>`', () => {
  assert.equal(workspaceLink({ section: 'agent', session: SESSION }), `/?section=agent&session=${SESSION}`)
  assert.equal(workspaceHref(at(`/mikka?section=agent&session=${SESSION}`), { section: 'coordinator' }), '/mikka')
})

test('projects and team pages have addresses; an older `?team=<id>` still opens the team\'s 主页', () => {
  assert.equal(workspaceLink({ section: 'projects', project: PROJECT }), `/?section=projects&project=${PROJECT}`)
  assert.equal(workspaceHref(at(`/mikka?section=projects&project=${PROJECT}`), { project: null }), '/mikka?section=projects')
  assert.equal(workspaceHref(at(`/mikka?section=projects&project=${PROJECT}`), { section: 'all-issues' }), '/mikka?section=all-issues')
  assert.equal(workspaceLink({ section: 'team-home', team: TEAM }), `/?team=${TEAM}`)
  assert.equal(workspaceHref(at(`/mikka?team=${TEAM}`), { section: 'team-projects', project: PROJECT }), `/mikka?team=${TEAM}&section=team-projects&project=${PROJECT}`)
  assert.equal(workspaceHref(at(`/mikka?team=${TEAM}&section=team-issues`), { section: 'team-home' }), `/mikka?team=${TEAM}`)
  assert.equal(workspaceHref(at(`/mikka?team=${TEAM}`), { section: 'all-issues' }), '/mikka?section=all-issues')
  assert.deepEqual(readLocation(new URLSearchParams(`team=${TEAM}`)), place({ section: 'team-home', team: TEAM }))
  assert.equal(readLocation(new URLSearchParams('section=team-home')).section, 'coordinator')
  assert.equal(readLocation(new URLSearchParams(`section=all-issues&team=${TEAM}`)).team, null)
})

test('a team page without its team is the page it would scope', () => {
  assert.equal(sectionFor('team-projects', null), 'projects')
  assert.equal(sectionFor('team-issues', null), 'all-issues')
  assert.equal(sectionFor('team-home', null), 'coordinator')
  assert.equal(sectionFor('team-home', TEAM), 'team-home')
  assert.equal(sectionFor('all-issues', null), 'all-issues')
  assert.equal(workspaceHref(at('/mikka'), { section: 'team-projects' }), '/mikka?section=projects')
})

test('a task opened from a chat names that chat; a bare link names none', () => {
  assert.equal(workspaceHref(at('/mikka'), { issue: ISSUE }), `/mikka?section=coordinator&issue=${ISSUE}`)
  assert.equal(workspaceHref(at(`/mikka?bot=${BOT}`), { issue: ISSUE }), `/mikka?bot=${BOT}&issue=${ISSUE}`)
  assert.equal(workspaceHref(at('/mikka?section=all-issues'), { issue: ISSUE }), `/mikka?section=all-issues&issue=${ISSUE}`)
  // A move inside the task keeps what it named, or that it named nothing.
  assert.equal(workspaceHref(at(`/mikka?section=coordinator&issue=${ISSUE}`), { thread: RUN }), `/mikka?section=coordinator&issue=${ISSUE}&thread=${RUN}`)
  assert.equal(workspaceHref(at(`/mikka?issue=${ISSUE}`), { thread: RUN }), `/mikka?issue=${ISSUE}&thread=${RUN}`)
  // Leaving the task for the chat is the bare address again; a team page names no chat.
  assert.equal(workspaceHref(at(`/mikka?section=coordinator&issue=${ISSUE}`), { issue: null }), '/mikka')
  assert.equal(workspaceHref(at(`/mikka?team=${TEAM}`), { issue: ISSUE }), `/mikka?team=${TEAM}&issue=${ISSUE}`)
  assert.equal(workspaceLink({ issue: ISSUE }), `/?issue=${ISSUE}`)
  assert.equal(workspaceLink({ section: 'coordinator', issue: ISSUE }), `/?section=coordinator&issue=${ISSUE}`)

  const origin = (search: string) => taskOrigin(new URLSearchParams(search))
  assert.deepEqual(origin(`section=coordinator&issue=${ISSUE}`), { section: 'coordinator', bot: null })
  assert.deepEqual(origin(`bot=${BOT}&issue=${ISSUE}`), { section: 'coordinator', bot: BOT })
  assert.deepEqual(origin(`section=all-issues&issue=${ISSUE}`), { section: 'all-issues', bot: null })
  assert.equal(origin(`issue=${ISSUE}`), null)
  assert.equal(origin(`section=team-home&issue=${ISSUE}`), null)
})

test('an invalid or stale address rewrites to what is shown', () => {
  assert.equal(canonicalHref(at(`/mikka?section=nope&issue=${ISSUE}`)), `/mikka?issue=${ISSUE}`)
  assert.equal(canonicalHref(at('/mikka?section=coordinator')), '/mikka')
  assert.equal(canonicalHref(at('/mikka?bot=not-an-id&thread=7')), '/mikka')
  assert.equal(canonicalHref(at('/mikka?section=plugins&app=gmail')), '/mikka?section=plugins&app=gmail')
  assert.equal(canonicalHref(at(`/mikka?bot=${BOT}&thread=${RUN}`), () => false), `/mikka?thread=${RUN}`)
  assert.equal(canonicalHref(at(`/mikka?bot=${BOT}&issue=${ISSUE}`), () => true), `/mikka?bot=${BOT}&issue=${ISSUE}`)
  assert.equal(canonicalHref(at(`/mikka?section=coordinator&issue=${ISSUE}&thread=${RUN}`)), `/mikka?section=coordinator&issue=${ISSUE}&thread=${RUN}`)
})

test('history marks: ✕ steps back to the entry that opened the task, in this page load only', () => {
  const doc = 'load-1'
  let mark: EntryMark | null = null
  // Chat (unmarked, a cold start) → task: one step back.
  mark = nextMark(mark, null, ISSUE, 'push', doc, false)
  assert.deepEqual(mark, { index: 1, task: { start: 1, doc, list: false } })
  assert.equal(stepsToOrigin(mark, doc), 1)
  // A thread beside it and ↑↓ keep the place that opened the task.
  mark = nextMark(mark, ISSUE, ISSUE, 'push', doc, false)
  mark = nextMark(mark, ISSUE, RUN, 'push', doc, true)
  assert.deepEqual(mark, { index: 3, task: { start: 1, doc, list: false } })
  assert.equal(stepsToOrigin(mark, doc), 3)
  // After a reload the earlier load's entries are not this page's.
  assert.equal(stepsToOrigin(mark, 'load-2'), 0)
  // Opened directly: no entry behind it.
  assert.equal(stepsToOrigin(nextMark(null, ISSUE, ISSUE, 'push', doc, false), doc), 0)
  assert.equal(stepsToOrigin(null, doc), 0)
  // Leaving the task clears it; a list remembers it opened the task.
  assert.deepEqual(nextMark(mark, ISSUE, null, 'push', doc, false), { index: 4, task: null })
  assert.equal(nextMark({ index: 4, task: null }, null, ISSUE, 'push', doc, true).task?.list, true)
  // Next's keys sit beside the mark; anything malformed reads as none.
  assert.deepEqual(readMark({ __NA: true, mikkaEntry: { index: 2, task: { start: 2, doc, list: true } } }), { index: 2, task: { start: 2, doc, list: true } })
  for (const state of [null, 'x', {}, { mikkaEntry: { index: 'a' } }]) assert.equal(readMark(state), null)
})

/** A browser history of its own: entries with state, back moves the index. */
function fakeBrowser(path: string, state: unknown = { __NA: true }) {
  const entries = [{ href: path, state }]
  let index = 0
  const location = { get href() { return `https://app.example${entries[index].href}` }, get pathname() { return new URL(this.href).pathname }, get search() { return new URL(this.href).search }, hash: '' }
  const history = {
    get state() { return entries[index].state },
    get length() { return entries.length },
    pushState(next: unknown, _: string, href: string) { entries.splice(index + 1, Infinity, { href, state: next }); index++ },
    replaceState(next: unknown, _: string, href: string) { entries[index] = { href, state: next } },
    back() { if (index > 0) index-- },
  }
  Object.assign(globalThis, { window: { location, history, dispatchEvent() { return true } } })
  return { history, path: () => entries[index].href }
}

test('canonicalizing an unchanged return address does not consume its pending popstate', () => {
  const chat = `/?workspace=one&bot=${BOT}`
  const browser = fakeBrowser(chat)
  queryMoved()
  browser.history.pushState(null, '', '/settings?workspace=one')
  queryMoved()
  browser.history.back()
  tidyAddress(() => true)
  assert.equal(queryMoved(), true, 'the returned bot still needs to be shown after the router renders its address')
  assert.equal(queryMoved(), false, 'the same query is handled only once')
  browser.history.replaceState(null, '', `${chat}#paragraph`)
  assert.equal(queryMoved(), false, 'an anchor-only history move must not change the workspace selection')
  goTo({ bot: null })
  assert.equal(queryMoved(), false, 'a workspace-owned move is already shown by its caller')
})

// ← in an open thread is the thread model's close (decision 0301, R-82): openThread records where it came from; closeThread goes back there.
test('closing a thread opened from here is back: no new entry, and back does not reopen it', () => {
  const browser = fakeBrowser(`/?bot=${BOT}`)
  openThread(RUN)
  assert.equal(browser.history.length, 2)
  closeThread()
  assert.equal(browser.path(), `/?bot=${BOT}`)
  assert.equal(browser.history.length, 2)
})

test('an Artifact opened and closed over a thread does not come back when the thread closes', () => {
  const browser = fakeBrowser(`/?bot=${BOT}`)
  openThread(RUN)
  goTo({ artifact: ARTIFACT })
  goTo({ artifact: null })
  closeThread()
  assert.equal(new URL(`https://app.example${browser.path()}`).searchParams.get('artifact'), null)
  assert.equal(new URL(`https://app.example${browser.path()}`).searchParams.get('thread'), null)
})

test('closing what a link opened replaces the entry, so back does not reopen it either', () => {
  const browser = fakeBrowser(`/?thread=${RUN}`)
  closeThread()
  assert.equal(browser.path(), '/')
  assert.equal(browser.history.length, 1)
})

test('a close after the address moved elsewhere replaces, and Next\'s state is kept', () => {
  const browser = fakeBrowser('/?section=all-issues')
  openThread(RUN)
  assert.equal((browser.history.state as { __NA?: boolean }).__NA, true)
  goTo({ issue: ISSUE, thread: RUN }, 'replace')
  closeThread()
  assert.equal(browser.path(), `/?section=all-issues&issue=${ISSUE}`)
  assert.equal(browser.history.length, 2)
})

test('a thread opened from a null history state still records where it came from', () => {
  const browser = fakeBrowser('/', null)
  openThread(RUN)
  assert.notEqual(browser.history.state, null)
  closeThread()
  assert.equal(browser.path(), '/')
})

test('a task opened beside the centre stays with its thread and closes when the centre moves', () => {
  const task = '11111111-1111-4111-8111-111111111111', run = '22222222-2222-4222-8222-222222222222', bot = '33333333-3333-4333-8333-333333333333'
  const withTask = workspaceHref(at(`/?bot=${bot}`), { task })
  assert.equal(readLocation(at(withTask).searchParams).task, task)
  const withThread = workspaceHref(at(withTask), { thread: run })
  assert.deepEqual([readLocation(at(withThread).searchParams).task, readLocation(at(withThread).searchParams).thread], [task, run])
  assert.equal(readLocation(at(workspaceHref(at(withThread), { section: 'all-issues' })).searchParams).task, null)
})

// Decision 2026-11-10: while a chat with a work area is on screen, a task or a thread opens as its tab; the address stays.
test('a chat\'s work area takes tasks and threads opened beside it, and gives them back when it goes', () => {
  const browser = fakeBrowser(`/?bot=${BOT}`)
  const opened: string[] = []
  const release = setWorkAreaOpener({ task: id => opened.push(`task:${id}`), thread: id => opened.push(`thread:${id}`) })
  openThread(RUN)
  openTask(ISSUE)
  navigate({ thread: RUN })
  navigate({ task: ISSUE, thread: null })
  navigate({ issue: ISSUE })
  assert.deepEqual(opened, [`thread:${RUN}`, `task:${ISSUE}`, `thread:${RUN}`, `task:${ISSUE}`])
  assert.equal(readLocation(at(browser.path()).searchParams).issue, ISSUE, 'the full task page is still a place of its own')
  release()
  openThread(RUN)
  assert.equal(opened.length, 4)
  assert.equal(readLocation(at(browser.path()).searchParams).thread, RUN)
})

test('an old 任务 link reads as the board: tasks have one entry', () => {
  assert.equal(sectionFromQuery('tasks'), 'all-issues')
  const location = readLocation(new URLSearchParams(`section=tasks&issue=${ISSUE}`))
  assert.equal(location.section, 'all-issues')
  assert.equal(location.issue, ISSUE)
})

test('an active chat work tab survives a document reload only on the same entry and account scope', () => {
  const browser = fakeBrowser('/?section=coordinator')
  const scope = 'owner/workspace/coordinator'
  rememberWorkTab(scope, `thread:${RUN}`)
  assert.deepEqual(workTabForEntry(scope), { kind: 'thread', id: RUN })
  assert.equal(workTabForEntry('another-owner/workspace/coordinator'), null)
  assert.equal(workTabForEntry('owner/another-workspace/coordinator'), null)
  assert.equal(workTabForEntry('owner/workspace/another-bot'), null)
  assert.equal(browser.path(), '/?section=coordinator')
  assert.equal(window.history.state.__NA, true)
  goTo({ section: 'all-issues' })
  assert.equal(workTabForEntry(scope), null)
  window.history.back()
  assert.deepEqual(workTabForEntry(scope), { kind: 'thread', id: RUN })
  rememberWorkTab(scope, `task:${ISSUE}`)
  assert.deepEqual(workTabForEntry(scope), { kind: 'task', id: ISSUE })
  rememberWorkTab(scope, null)
  assert.equal(workTabForEntry(scope), null)
})
