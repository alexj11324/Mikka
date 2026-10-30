import assert from 'node:assert/strict'
import test from 'node:test'

import { sectionFromQuery, writeSectionQuery } from './workspace-navigation'

test('the task board survives a reload and a shared link', () => {
  const params = new URLSearchParams('bot=b1')
  writeSectionQuery(params, 'all-issues')
  assert.equal(params.toString(), 'bot=b1&section=all-issues')
  assert.equal(sectionFromQuery(params.get('section') ?? undefined), 'all-issues')
})

test('sections without a link of their own drop the section', () => {
  const params = new URLSearchParams('section=all-issues')
  writeSectionQuery(params, 'team-issues')
  assert.equal(params.toString(), '')
})

test('unknown or missing sections open the chat', () => {
  assert.equal(sectionFromQuery(undefined), 'coordinator')
  assert.equal(sectionFromQuery('team-home'), 'coordinator')
  assert.equal(sectionFromQuery('projects'), 'projects')
})
