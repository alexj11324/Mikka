import assert from 'node:assert/strict'
import test from 'node:test'

import { readLocation, sameLocation, sectionFromQuery, workspaceHref, workspaceLink, workspaceSearch, writeSectionQuery } from './workspace-navigation'

const BOT = '3f0c9d2e-5b1a-4c7e-9f00-1a2b3c4d5e6f'
const ISSUE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
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
  assert.deepEqual(readLocation(new URLSearchParams(`section=coordinator&bot=${BOT}`)), { section: 'coordinator', bot: BOT, issue: null })
})

test('an address reads back as the place it was written for', () => {
  for (const place of [
    { section: 'coordinator', bot: null, issue: null },
    { section: 'coordinator', bot: BOT, issue: null },
    { section: 'coordinator', bot: BOT, issue: ISSUE },
    { section: 'all-issues', bot: null, issue: ISSUE },
    { section: 'artifacts', bot: null, issue: null },
    { section: 'projects', bot: null, issue: null },
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
  assert.deepEqual(readLocation(new URLSearchParams('issue=../x&bot=nope')), { section: 'coordinator', bot: null, issue: null })
})

test('links built from nothing', () => {
  assert.equal(workspaceLink({ issue: ISSUE }), `/?issue=${ISSUE}`)
  assert.equal(workspaceLink({ bot: BOT }), `/?bot=${BOT}`)
  assert.equal(workspaceLink({ section: 'coordinator' }), '/')
  assert.equal(workspaceSearch({ section: 'all-issues' }), '?section=all-issues')
})
