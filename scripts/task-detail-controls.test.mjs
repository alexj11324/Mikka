import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement, useState } from 'react'
import { metadataSchema } from '../lib/issue-metadata.ts'

const browser = new Window({ url: 'https://mikka.example/mikka' })
const noop = () => {}
const translate = Object.assign(key => key, { has: () => true })
const stub = (path, namedExports) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
let teamId, response, issue, child, frame, teamWrites, favoriteDenied, moves, reads, optionsRead
const teams = ['existing', 'another'].map(id => ({ id, identifier: id, name: id }))
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ relativeTime: noop }), useNow: () => new Date() } })
mock.module('sonner', { namedExports: { toast: { error: noop, success: noop } } })
mock.module('swr', { defaultExport: key => {
  if (key?.[0] === 'issue-property-options') return optionsRead
  if (key === 'teams') return { data: teams }
  if (key?.[0] === 'issue-team') return { data: teamId, mutate: async value => { teamId = value } }
  if (key?.[0] === 'issue-connections') return { data: [issue, child], mutate: async () => reads.push('connections') }
  return {}
}, namedExports: { unstable_serialize: JSON.stringify, useSWRConfig: () => ({ mutate: async key => {
  if (typeof key === 'function') {
    assert.equal(key(['issues', 'another-owner', 'workspace']), false)
    if (key(['issues', 'owner', 'workspace'])) reads.push('viewer-list')
  }
} }) } })
stub('app/actions/team-relations.ts', {
  getIssueTeam: async () => teamId,
  setIssueTeam: async input => { teamWrites.push(input); return response ?? { ok: true, data: input.teamId } },
})
stub('app/actions/teams.ts', { listTeams: async () => teams })
stub('app/actions/issues.ts', {
  setIssueScope: noop, promoteIssueToTeam: noop,
  moveIssue: async input => { moves.push(input); child = { ...child, status: input.status, revision: child.revision + 1 }; return { issue: child } },
})
stub('app/actions/issue-metadata.ts', { getIssuePropertyOptions: noop, updateIssueMetadata: noop })
stub('app/actions/issue-operations.ts', {
  createLinkedIssue: noop, setIssueDeleted: noop, updateIssueRelation: noop, listIssueConnections: noop,
  toggleIssuePreference: async () => {
    if (favoriteDenied) return { error: 'issueUnavailable' }
    const favorites = issue.metadata.favoriteUserIds.length ? [] : ['owner']
    return { issue: { ...issue, revision: issue.revision + 1, metadata: { ...issue.metadata, favoriteUserIds: favorites } } }
  },
})
stub('hooks/use-live-key.tsx', { useLiveKey: noop })
stub('hooks/use-bot-tasks.ts', { localTaskState: () => ({ state: 'todo' }) })
stub('lib/hooks/use-relation-search.ts', { useRelationSearch: noop })
stub('lib/use-action-error.ts', { useActionError: () => translate })
stub('components/workspace/issue-activity-feed.tsx', { useActivityEvents: () => [] })
stub('components/workspace/issue-activity.tsx', { useActivityDrafts: () => ({}) })
stub('components/workspace/issue-threads.tsx', { useIssueThreads: () => ({ data: [] }) })
stub('components/workspace/issue-metadata-controls.tsx', { useIssueMetadataSave: () => ({}), IssueMetadataControls: noop, AccessChangeDialog: noop })
stub('components/workspace/issue-assignee-menu.tsx', { AgentSphere: noop })
stub('components/workspace/issue-detail-properties.tsx', { overdue: () => false })
stub('components/workspace/issue-pull-request-link.tsx', { PullRequestStatus: noop })
stub('components/nav/bot-avatar.tsx', { BotAvatar: noop, COORDINATOR_AVATAR: {} })

let createRoot, FramedTask
before(async () => {
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FramedTask } = await import('../components/workspace/task-detail-frame.tsx'))
})
beforeEach(() => {
  issue = { id: 'task', userId: 'owner', title: 'Task', identifier: 'T-1', status: 'todo', revision: 3, scope: 'personal', createdAt: new Date(),
    metadata: metadataSchema.parse({ delegate: { id: 'bot', name: 'Assigned bot', kind: 'bot', image: null } }) }
  child = { ...issue, id: 'child', title: 'Child', revision: 2, metadata: { ...issue.metadata, parentId: issue.id } }
  optionsRead = {}
  teamId = 'existing'; response = null; favoriteDenied = false; teamWrites = []; reads = []; moves = []
})
after(() => browser.close())

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const Capture = props => { frame = props; return null }
  function Task() {
    const [task, setTask] = useState(issue)
    return createElement(FramedTask, { Frame: Capture, task, userId: 'owner', title: task.title, status: task.status, priority: 'normal',
      agentActivity: { items: [] }, versions: [], getCurrent: async () => issue, adopt: saved => { issue = saved; setTask(saved) } })
  }
  await act(async () => root.render(createElement(Task)))
  return () => act(async () => { root.unmount(); host.remove() })
}
const row = id => frame.rows.find(item => item.id === id)
const pickTeam = id => act(async () => row('team').menu.find(item => item.id === id).onSelect())

test('team selection confirms the current team once after reopen and rejected changes retain the saved team', async () => {
  const dispose = await mount()
  try {
    await pickTeam('existing')
    assert.deepEqual(teamWrites, [{ issueId: 'task', teamId: 'existing', expectedTeamId: 'existing' }])
    await pickTeam('existing')
    assert.equal(teamWrites.length, 1)
    assert.deepEqual(reads, [])
    response = { ok: false, error: 'denied' }
    await pickTeam('another')
    assert.equal(row('team').menu.find(item => item.checked).id, 'existing')
    assert.equal(frame.rowsError, 'denied')
    response = null
    await pickTeam('another')
    assert.equal(row('team').menu.find(item => item.checked).id, 'another')
    assert.deepEqual(reads, ['viewer-list'])
  } finally { await dispose() }
})

test('the saved delegate is visible before its first run and favorites immediately adopt the server revision', async () => {
  const dispose = await mount()
  try {
    assert.equal(row('delegate').value.text, 'Assigned bot')
    await act(async () => frame.favorite.toggle())
    assert.equal(issue.revision, 4)
    assert.deepEqual(issue.metadata.favoriteUserIds, ['owner'])
    favoriteDenied = true
    await act(async () => frame.favorite.toggle())
    assert.equal(frame.favorite.on, true)
    assert.equal(issue.revision, 4)
  } finally { await dispose() }
})

test('completing and reopening a subtask refreshes the parent connections and the signed-in viewer’s lists', async () => {
  const dispose = await mount()
  try {
    await act(async () => frame.subtasks.items[0].onToggle())
    await act(async () => frame.subtasks.items[0].onToggle())
    assert.deepEqual(moves, [{ id: 'child', revision: 2, status: 'done' }, { id: 'child', revision: 3, status: 'todo' }])
    assert.deepEqual(reads, ['connections', 'viewer-list', 'connections', 'viewer-list'])
  } finally { await dispose() }
})


test('label and project placeholders report the options read and retry it', async () => {
  const dispose = await mount()
  try {
    const menu = id => id === 'labels' ? row(id).add.menu : row(id).menu
    for (const id of ['labels', 'project']) {
      const loading = menu(id).find(item => item.id === 'loading')
      assert.equal(loading.label, 'loading')
      assert.equal(loading.onSelect, undefined)
    }
    optionsRead = { error: new Error('unavailable'), mutate: async () => reads.push('property-options') }
    await act(async () => row('labels').onOpen())
    for (const id of ['labels', 'project']) {
      const retry = menu(id).find(item => item.id === 'reload')
      assert.equal(retry.label, 'retry')
      await act(async () => retry.onSelect())
    }
    assert.deepEqual(reads, ['property-options', 'property-options'])
  } finally { await dispose() }
})
