import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterSidebarRows, groupSidebarRows, matchesSidebarFilters, matchesSidebarQuery, sidebarFilters, sidebarGroupBy, sidebarOptions, sortSidebarRows,
  type SidebarViewRow,
} from './sidebar-view'

const row = (over: Partial<SidebarViewRow> & { name: string }): SidebarViewRow => ({ id: over.name, unread: false, ...over })
const names = (rows: readonly SidebarViewRow[]) => rows.map(row => row.name)

const api = row({ name: 'API Bot', at: '2026-11-18T10:00:00.000Z', unread: true, waitingCount: 2 })
const docs = row({ name: 'Docs Bot', at: '2026-11-19T10:00:00.000Z', working: true })
const ops = row({ name: 'Ops Bot', at: '2026-11-17T10:00:00.000Z', threads: ['#71 Infisical 连接超时排查'] })

test('置顶优先 keeps the list order the reads produced', () => {
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'pinned')), ['API Bot', 'Docs Bot', 'Ops Bot'])
})

test('最近活动 puts the newest first and 名称 sorts by name', () => {
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'recent')), ['Docs Bot', 'API Bot', 'Ops Bot'])
  assert.deepEqual(names(sortSidebarRows([api, docs, ops], 'name')), ['API Bot', 'Docs Bot', 'Ops Bot'])
})

test('a row with no activity sorts last in 最近活动, never first', () => {
  const quiet = row({ name: 'Quiet Bot', at: null })
  assert.deepEqual(names(sortSidebarRows([quiet, api], 'recent')), ['API Bot', 'Quiet Bot'])
})

test('a filter keeps only the rows it answers, and every filter on must match', () => {
  assert.equal(matchesSidebarFilters(api, ['unread']), true)
  assert.equal(matchesSidebarFilters(api, ['unread', 'waiting']), true)
  assert.equal(matchesSidebarFilters(api, ['unread', 'working']), false)
  assert.equal(matchesSidebarFilters(docs, ['working']), true)
  assert.equal(matchesSidebarFilters(docs, []), true)
})

test('the search box reads the name, the latest line and the threads under the row', () => {
  assert.equal(matchesSidebarQuery(api, ''), true)
  assert.equal(matchesSidebarQuery(api, 'api'), true)
  assert.equal(matchesSidebarQuery(api, 'missing'), false)
  assert.equal(matchesSidebarQuery(ops, 'Infisical'), true)
  assert.equal(matchesSidebarQuery(row({ name: 'A', preview: '登录超时' }), '登录'), true)
})

test('filters and the search box both narrow the same list', () => {
  assert.deepEqual(names(filterSidebarRows([api, docs, ops], ['unread'], '')), ['API Bot'])
  assert.deepEqual(names(filterSidebarRows([api, docs, ops], [], 'Bot')), ['API Bot', 'Docs Bot', 'Ops Bot'])
  assert.deepEqual(names(filterSidebarRows([api, docs, ops], [], 'Infisical')), ['Ops Bot'])
})

test('分组 未读 heads the unread rows and leaves the rest under 其他', () => {
  const buckets = groupSidebarRows([api, docs, ops], 'unread')
  assert.deepEqual(buckets.map(bucket => bucket.id), ['unread', 'other'])
  assert.deepEqual(names(buckets[0].rows), ['API Bot'])
  assert.deepEqual(names(buckets[1].rows), ['Docs Bot', 'Ops Bot'])
})

test('an empty bucket is left out, and 无 is one unnamed bucket', () => {
  assert.deepEqual(groupSidebarRows([docs, ops], 'unread').map(bucket => bucket.id), ['other'])
  assert.deepEqual(groupSidebarRows([], 'unread'), [])
  assert.deepEqual(groupSidebarRows([docs, ops], 'none').map(bucket => bucket.id), ['all'])
  assert.deepEqual(groupSidebarRows([], 'none'), [])
})

test('a Bot section offers every dimension; group chats only what their rows carry', () => {
  assert.deepEqual(sidebarOptions('bot').groups, ['none', 'unread', 'waiting', 'working'])
  assert.deepEqual(sidebarOptions('group'), { groups: ['none', 'unread'], filters: ['unread'] })
})

test('a choice the section cannot answer reads as 无 and no filter, never as an empty list', () => {
  assert.equal(sidebarGroupBy('group', 'working'), 'none')
  assert.equal(sidebarGroupBy('group', 'unread'), 'unread')
  assert.deepEqual(sidebarFilters('group', ['unread', 'working', 'working']), ['unread'])
  assert.deepEqual(sidebarFilters('bot', ['working', 'unread']), ['working', 'unread'])
})
