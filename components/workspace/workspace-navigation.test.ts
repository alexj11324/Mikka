import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalHref, nextMark, readLocation, readMark, sameLocation, sectionFromQuery, stepsToOrigin, taskOrigin, workspaceHref, workspaceLink, workspaceSearch, writeSectionQuery, type EntryMark } from './workspace-navigation'

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

test('a task opened from a chat names that chat; a bare link names none', () => {
  assert.equal(workspaceHref(at('/mikka'), { issue: ISSUE }), `/mikka?section=coordinator&issue=${ISSUE}`)
  assert.equal(workspaceHref(at(`/mikka?bot=${BOT}`), { issue: ISSUE }), `/mikka?bot=${BOT}&issue=${ISSUE}`)
  assert.equal(workspaceHref(at('/mikka?section=all-issues'), { issue: ISSUE }), `/mikka?section=all-issues&issue=${ISSUE}`)
  // A move inside the task keeps what it named, or that it named nothing.
  assert.equal(workspaceHref(at(`/mikka?section=coordinator&issue=${ISSUE}`), { thread: RUN }), `/mikka?section=coordinator&issue=${ISSUE}&thread=${RUN}`)
  assert.equal(workspaceHref(at(`/mikka?issue=${ISSUE}`), { thread: RUN }), `/mikka?issue=${ISSUE}&thread=${RUN}`)
  // Leaving the task for the chat is the bare address again; a team page names no chat.
  assert.equal(workspaceHref(at(`/mikka?section=coordinator&issue=${ISSUE}`), { issue: null }), '/mikka')
  assert.equal(workspaceHref(at('/mikka?team=t1'), { issue: ISSUE }), `/mikka?team=t1&issue=${ISSUE}`)
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
