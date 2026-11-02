import assert from 'node:assert/strict'
import test from 'node:test'

import { closeTo, goTo, readLocation, sameLocation, sectionFromQuery, workspaceHref, workspaceLink, workspaceSearch, writeSectionQuery } from './workspace-navigation'

const BOT = '3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f'
const ISSUE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const RUN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const at = (path: string) => new URL(`https://app.example${path}`)

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
  assert.deepEqual(readLocation(new URLSearchParams(`section=coordinator&bot=${BOT}`)), { section: 'coordinator', bot: BOT, issue: null, thread: null })
})

test('an address reads back as the place it was written for', () => {
  for (const place of [
    { section: 'coordinator', bot: null, issue: null, thread: null },
    { section: 'coordinator', bot: BOT, issue: null, thread: null },
    { section: 'coordinator', bot: BOT, issue: ISSUE, thread: null },
    { section: 'coordinator', bot: null, issue: null, thread: RUN },
    { section: 'coordinator', bot: BOT, issue: ISSUE, thread: RUN },
    { section: 'all-issues', bot: null, issue: ISSUE, thread: null },
    { section: 'artifacts', bot: null, issue: null, thread: RUN },
    { section: 'projects', bot: null, issue: null, thread: null },
  ] as const) {
    const href = workspaceHref(at('/mikka/zh-CN'), place)
    assert.ok(href.startsWith('/mikka/zh-CN'), href)
    assert.ok(sameLocation(readLocation(new URL(href, 'https://app.example').searchParams), place), href)
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
  assert.equal(workspaceHref(at('/mikka?team=t1#x'), { issue: ISSUE }), `/mikka?team=t1&issue=${ISSUE}#x`)
})

test('ids that are not UUIDs are not places', () => {
  assert.deepEqual(readLocation(new URLSearchParams('issue=../x&bot=nope')), { section: 'coordinator', bot: null, issue: null, thread: null })
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
  Object.assign(globalThis, { window: { location, history } })
  return { history, path: () => entries[index].href }
}

test('closing a thread or task opened from here is back: no new entry, and back does not reopen it', () => {
  const browser = fakeBrowser(`/?bot=${BOT}`)
  goTo({ thread: RUN })
  assert.equal(browser.history.length, 2)
  assert.equal(closeTo({ thread: null }), true)
  assert.equal(browser.path(), `/?bot=${BOT}`)
  assert.equal(browser.history.length, 2)

  goTo({ issue: ISSUE })
  assert.equal(closeTo({ issue: null }), true)
  assert.equal(browser.path(), `/?bot=${BOT}`)
})

test('closing what a link opened replaces the entry, so back does not reopen it either', () => {
  const browser = fakeBrowser(`/?thread=${RUN}`)
  assert.equal(closeTo({ thread: null }), false)
  assert.equal(browser.path(), '/')
  assert.equal(browser.history.length, 1)
})

test('a close that lands somewhere else than the pushed-from place replaces, and Next\'s state is kept', () => {
  const browser = fakeBrowser('/?section=all-issues')
  goTo({ issue: ISSUE })
  assert.equal((browser.history.state as { __NA?: boolean }).__NA, true)
  assert.equal(closeTo({ section: 'coordinator', issue: null }), false)
  assert.equal(browser.path(), '/')
  assert.equal(browser.history.length, 2)
})

test('a null history state stays null on push', () => {
  const browser = fakeBrowser('/', null)
  goTo({ thread: RUN })
  assert.equal(browser.history.state, null)
  assert.equal(closeTo({ thread: null }), false)
})
