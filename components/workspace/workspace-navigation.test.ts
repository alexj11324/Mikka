import assert from 'node:assert/strict'
import test from 'node:test'

import { readLocation, sectionFor, sameLocation, sectionFromQuery, workspaceHref, workspaceLink, workspaceSearch, writeSectionQuery } from './workspace-navigation'
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
const NOWHERE = { bot: null, group: null, session: null, team: null, project: null, issue: null, thread: null, artifact: null }
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
  assert.equal(workspaceHref(at('/mikka?ref=t1#x'), { issue: ISSUE }), `/mikka?ref=t1&issue=${ISSUE}#x`)
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
