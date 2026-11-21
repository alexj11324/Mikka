import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { Window } from 'happy-dom'
import { z } from 'zod'
import { act, createElement, useState } from 'react'
import { desktopActionSchemas } from '../lib/desktop-rpc/schemas.ts'
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES } from '../lib/issue-meta.ts'
import { metadataSchema } from '../lib/issue-metadata.ts'

const browser = new Window({ url: 'https://mikka.example/mikka' })
const noop = () => {}
const translate = Object.assign(key => key, { has: () => true })
const stub = (path, namedExports) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
let teamKeys, timeline, timelineHistory, teamId, response, issue, child, frame, teamWrites, favoriteDenied, saveMetadata, createChild, connectionsError, moves, reads, optionsRead
const teams = ['existing', 'another'].map(id => ({ id, identifier: id, name: id }))
mock.module('@/lib/intl/i18n-client', { namedExports: { useTranslations: () => translate, useMessages: () => ({ IssueDetail: { work: { states: {} } }, GroupTask: { stage: {}, status: {} } }), useFormatter: () => ({ relativeTime: noop, dateTime: date => date.toISOString().slice(0, 10) }), useNow: () => new Date() } })
mock.module('sonner', { namedExports: { toast: { error: noop, success: noop } } })
mock.module('swr', { defaultExport: key => {
  if (key?.[0] === 'issue-pull-request-timeline') return { data: timeline }
  if (key?.[0] === 'issue-property-options') return optionsRead
  if (key === 'teams') return { data: teams }
  if (key?.[0] === 'issue-team') { teamKeys.push(key); return { data: teamId, mutate: async value => { teamId = value } } }
  if (key?.[0] === 'issue-connections') return { data: [issue, child], error: connectionsError, mutate: async () => reads.push('connections') }
  return {}
}, namedExports: { unstable_serialize: JSON.stringify, useSWRConfig: () => ({ mutate: async key => {
  if (Array.isArray(key) && key[0] === 'issue') {
    reads.push('issue-detail')
    return issue
  }
  if (Array.isArray(key) && key[0] === 'issue-connections') reads.push('revalidate-connections')
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
stub('app/actions/task-list.ts', { listUnreadTaskIds: async () => [], setTaskUnread: async () => ({ unread: false }), countTaskListViews: async () => ({}) })
stub('app/actions/task-domain.ts', { getTaskPresentations: () => { throw new Error('Unexpected Task presentation read in detail controls fixture') } })
stub('app/actions/issues.ts', {
  setIssueScope: noop, promoteIssueToTeam: noop,
  moveIssue: async input => { moves.push(input); child = { ...child, status: input.status, revision: child.revision + 1 }; return { issue: child } },
})
stub('app/actions/issue-metadata.ts', { getIssuePropertyOptions: noop, updateIssueMetadata: input => saveMetadata(input) })
stub('app/actions/issue-operations.ts', {
  createLinkedIssue: input => createChild(input), setIssueDeleted: async () => ({ issue }), updateIssueRelation: noop, listIssueConnections: noop,
  toggleIssuePreference: async () => {
    if (favoriteDenied) return { error: 'issueUnavailable' }
    const favorites = issue.metadata.favoriteUserIds.length ? [] : ['owner']
    return { issue: { ...issue, revision: issue.revision + 1, metadata: { ...issue.metadata, favoriteUserIds: favorites } } }
  },
})
stub('hooks/use-live-key.tsx', { useLiveKey: noop, useLiveKeys: noop, useLiveScope: () => null })
stub('hooks/use-bot-tasks.ts', { localTaskState: () => ({ state: 'todo' }) })
stub('lib/hooks/use-relation-search.ts', { useRelationSearch: noop })
stub('lib/use-action-error.ts', { useActionError: () => translate })
stub('components/workspace/issue-activity-feed.tsx', { useActivityEvents: () => () => timelineHistory ?? [] })
stub('components/workspace/issue-activity.tsx', { useActivityDrafts: (_id, _comment, onReply) => ({ sendReply: onReply }) })
stub('components/workspace/issue-threads.tsx', { useIssueThreads: () => ({ data: [{ detail: { agentName: 'Former delegate', bot: { color: 'blue', shape: 'round' } } }] }) })
stub('components/workspace/issue-metadata-controls.tsx', { useIssueMetadataSave: () => ({ persist: patch => saveMetadata({ patch }) }), IssueMetadataControls: noop, AccessChangeDialog: noop })
stub('components/workspace/issue-assignee-menu.tsx', { AgentSphere: noop })
stub('components/workspace/issue-detail-properties.tsx', { overdue: () => false })
stub('components/workspace/issue-pull-request-link.tsx', { PullRequestStatus: noop })
stub('components/nav/bot-avatar.tsx', { BotAvatar: noop, COORDINATOR_AVATAR: {} })

let createRoot, FramedTask
before(async () => {
  for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement']) {
    Object.defineProperty(globalThis, name, { value: name === 'window' ? browser : browser[name], configurable: true })
  }
  globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser)
  globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FramedTask } = await import('../components/workspace/task-detail-frame.tsx'))
})
beforeEach(() => {
  timeline = undefined; timelineHistory = []
  issue = { id: 'task', userId: 'owner', title: 'Task', identifier: 'T-1', status: 'todo', revision: 3, scope: 'personal', createdAt: new Date(),
    metadata: metadataSchema.parse({ delegate: { id: 'bot', name: 'Assigned bot', kind: 'bot', image: null } }) }
  child = { ...issue, id: 'child', title: 'Child', revision: 2, metadata: { ...issue.metadata, parentId: issue.id } }
  optionsRead = {}
  teamKeys = []; teamId = 'existing'; response = null; favoriteDenied = false; saveMetadata = noop; createChild = noop; connectionsError = null; teamWrites = []; reads = []; moves = []
})
after(() => browser.close())

async function mount({ showDialogs = false, ...props } = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const Capture = props => { frame = props; return showDialogs ? props.dialogs : null }
  function Task() {
    const [task, setTask] = useState(issue)
    return createElement(FramedTask, { Frame: Capture, task, userId: 'owner', title: task.title, status: task.status, priority: 'normal', locked: false, agentActivity: { items: [] }, earlierActivity: { hasMore: false, loading: false, failed: false, load: noop }, ...props,
      versions: [], getCurrent: async () => issue, adopt: saved => { issue = saved; setTask(saved) } })
  }
  await act(async () => root.render(createElement(Task)))
  return () => act(async () => { root.unmount(); host.remove() })
}
const row = id => frame.rows.find(item => item.id === id)
// The task page has no Work section (R-62): the Pull requests property is where the authorized receipts show.
test('the Pull requests property shows the authorized pull receipts, including an empty set', async () => {
  issue.metadata.pullRequests = [{ url: 'https://github.com/example/legacy/pull/1', state: 'open' }]
  const current = { url: 'https://github.com/example/review/pull/2', state: 'merged' }
  for (const receipts of [[current], []]) {
    const done = await mount({ agentActivity: { items: [], work: { presentation: { pullRequests: receipts } } } })
    try {
      assert.equal(frame.work, undefined)
      assert.deepEqual(row('pullRequests')?.chips.map(chip => chip.href) ?? [], receipts.map(pull => pull.url))
    } finally { await done() }
  }
})

test('a provider merge uses its actual time once; the revision remains when the matching provider receipt is absent', async () => {
  const url = 'https://github.com/Example/repo/pull/5'
  issue.metadata.pullRequests = [{ url, title: 'Change', state: 'merged' }]
  const at = '2026-11-14T13:00:00.000Z', mergedAt = '2026-11-14T12:00:00.000Z'
  timelineHistory = [
    { id: 'merged-revision', kind: 'pull', at, pullAction: 'merged', pullHref: url.toLowerCase() + '/', text: 'Merged' },
    { id: 'linked-revision', kind: 'pull', at, pullAction: 'linked', pullHref: url, text: 'Linked' },
  ]
  for (const available of [true, false]) {
    timeline = { items: available ? [{ url, title: 'Change', state: 'merged', createdAt: null, mergedAt }] : [] }
    const done = await mount()
    try {
      const items = frame.activity.items({ threads: [], anchors: [] })
      assert.deepEqual(items.map(item => [item.id, item.at]), available
        ? [[`pull:${url}:merged`, mergedAt], ['history:linked-revision', at]]
        : [['history:linked-revision', at], ['history:merged-revision', at]])
    } finally { await done() }
  }
})

test('both activity layouts show the official Bot comment exactly once and retain the human reply and its original write target', async () => {
  const first = { id: 'stage', at: '2026-11-15T00:00:00Z', author: 'Bot', body: 'Review' }
  const reply = { id: 'genuine', at: '2026-11-15T00:01:00Z', author: 'Alex', body: 'Review' }
  const writes = []
  const discussion = { onReply: (...args) => writes.push(args), anchors: [], threads: [{ id: 'factory', author: first.author, createdAt: first.at, resolved: false, messages: [first, reply] }] }
  const done = await mount({ editor: (_after, activity) => activity(discussion), agentActivity: { items: [], work: { presentation: { factoryStageComments: [{ threadId: 'factory', messageId: 'stage' }] } } } })
  try {
    frame.description({ afterDescription: null, activity: () => null })
    const folded = frame.activity.items(discussion)
    assert.deepEqual(folded.map(row => [row.actor, row.thread.id, row.thread.author, row.at, row.thread.messages.map(m => m.id)]), [['bot', 'factory', 'Bot', first.at, ['stage', 'genuine']]])
    frame.activity.drafts.sendReply(folded[0].id, 'Reply to review', 'operation')
    frame.activity.drafts.sendReply(discussion.threads[0].id, 'Legacy reply', 'legacy')
    assert.equal(frame.activity.drafts.sendReply('discussion:foreign:stage', 'Unknown target', 'unknown'), false)
    assert.deepEqual(writes, [['factory', 'Reply to review', 'operation', 'stage'], ['factory', 'Legacy reply', 'legacy']])
    const expanded = frame.activity.timeline(discussion, [])
    assert.deepEqual(expanded.map(row => [row.id, row.actor, row.thread.id, row.message.first, row.message.last]), [
      ['discussion:factory:stage', 'bot', 'factory', true, false], ['discussion:factory:genuine', undefined, 'factory', false, true],
    ])
  } finally { await done() }
})

test('properties link only admitted conversations and show the recorded Factory branch', async () => {
  const opened = []
  const done = await mount({ agentActivity: {
    items: [],
    threads: [
      { id: 'run', createdAt: '2026-11-14T10:00:00Z', attempts: [], detail: { name: 'Worker review', harness: 'codex' } },
      { id: 'hidden', createdAt: '2026-11-14T10:05:00Z', attempts: [], detail: null },
    ],
    openThread: id => opened.push(id), work: {
      presentation: { linkedChats: [{ id: 'chat', title: 'Planning' }] },
      factory: { task: { review: { summary: { branch: 'feature/review' } } } },
    },
  } })
  try {
    assert.equal(row('branch').value.text, 'feature/review')
    const { chips } = row('conversations')
    assert.deepEqual(chips.map(chip => [chip.id, chip.text]), [['chat:chat', 'Planning'], ['run:run', 'Worker review']])
    await act(async () => chips[1].menu[0].onSelect())
    assert.deepEqual(opened, ['run'])
  } finally { await done() }
})

const pickTeam = id => act(async () => row('team').menu.find(item => item.id === id).onSelect())

test('joined task team uses its authorized selection, refreshes writes and conflicts, and keeps the older read viewer scoped', async () => {
  const refreshes = []
  const joined = { teamId: null, refresh: async () => { refreshes.push('joined') } }
  const done = await mount({ teamSnapshot: joined })
  try {
    assert.deepEqual(teamKeys, [], 'opening the joined frame must not start another task-scoped read')
    assert.ok(row('team').menu.find(choice => choice.id === 'none').checked)
    await pickTeam('another')
    assert.deepEqual(teamWrites, [{ issueId: 'task', teamId: 'another', expectedTeamId: null }])
    assert.deepEqual(refreshes, ['joined'])
    response = { ok: false, code: 'teamIssueChanged', error: 'Concurrent team change' }
    await pickTeam('existing')
    assert.deepEqual(refreshes, ['joined', 'joined'])
    assert.deepEqual(teamKeys, [])
  } finally { await done() }
  const old = await mount()
  try {
    assert.deepEqual(teamKeys, [['issue-team', 'task', 'owner']])
    assert.ok(row('team').menu.find(choice => choice.id === 'existing').checked)
  } finally { await old() }
  teamKeys = []
  const preview = await mount({ preview: true, locked: true })
  try { assert.deepEqual(teamKeys, [], 'a cached preview cannot read team selection') } finally { await preview() }
})

test('confirmed deletion refreshes the viewer list without reading connections for the deleted task', async () => {
  let deleted = false
  const dispose = await mount({ showDialogs: true, onDeleted: () => { deleted = true } })
  try {
    await act(async () => frame.menu.items.find(item => item.id === 'delete').onSelect())
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'deleteAction')
    assert.ok(confirm, 'delete confirmation must be available')
    await act(async () => confirm.click())
    assert.equal(deleted, true)
    assert.deepEqual(reads, ['viewer-list'])
  } finally { await dispose() }
})

test('Task property menus expose every writable value, send precisely that value and lock for readers', async () => {
  const selected = { status: [], priority: [] }
  const save = desktopActionSchemas['issues.saveIssue']
  // The title and document use the inline editors exercised by task-detail-live.
  // Request coordinates are not editable properties.
  const propertyCodes = { status: ISSUE_STATUS_CODES, priority: ISSUE_PRIORITY_CODES }
  const saveInput = z.toJSONSchema(save, { io: 'input', unrepresentable: 'any' }).prefixItems[0]
  assert.deepEqual(Object.keys(saveInput.properties).sort(),
    // stateId refines status to one of the workspace's states (decision 2026-11-19-2115); tests/workspace-issue-states.db.test.ts covers it.
    ['id', 'revision', 'workspaceId', 'title', 'content', 'stateId', ...Object.keys(propertyCodes)].sort(),
    'classify each new save field and cover its consumer')
  const input = { title: 'Task', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' }
  const dispose = await mount({
    onStatus: value => selected.status.push(value),
    onPriority: value => selected.priority.push(value),
  })
  try {
    for (const [field, codes] of Object.entries(propertyCodes)) {
      const property = row(field)
      assert.equal(property.disabled, false)
      assert.deepEqual(property.menu.map(choice => choice.id), [...codes])
      assert.deepEqual(property.menu.filter(choice => choice.checked).map(choice => choice.id), [input[field]])
      for (const choice of property.menu) {
        choice.onSelect()
        assert.equal(selected[field].at(-1), choice.id)
        assert.equal(save.safeParse([{ ...input, [field]: choice.id }]).success, true, choice.id)
      }
      assert.deepEqual(selected[field], [...codes])
    }
    for (const state of ['queued', 'running', 'waiting', 'blocked', 'failed']) {
      assert.ok(!row('status').menu.some(choice => choice.id === state), state)
      assert.equal(save.safeParse([{ ...input, status: state }]).success, false, state)
    }
  } finally { await dispose() }
  const closeReadOnly = await mount({ locked: true })
  try {
    for (const field of ['status', 'priority']) assert.equal(row(field).disabled, true, field)
  } finally { await closeReadOnly() }
})

test('the verified read-only Task menu exposes history alone and a cached preview keeps the menu locked', async () => {
  const opened = []
  const dispose = await mount({ locked: true, preview: false, userId: 'reader', onHistory: () => opened.push('history') })
  try {
    assert.equal(frame.menu.disabled, false, 'a verified reader can open the menu')
    assert.deepEqual(frame.menu.items.map(item => item.id), ['history'])
    frame.menu.items[0].onSelect()
    assert.deepEqual(opened, ['history'])
    assert.equal(frame.favorite.disabled, true)
  } finally { await dispose() }

  const disposePreview = await mount({ locked: true, preview: true, userId: 'reader' })
  try { assert.equal(frame.menu.disabled, true) } finally { await disposePreview() }
})

test('reselecting the current team does not write and rejected changes retain the saved team', async () => {
  const dispose = await mount()
  try {
    await pickTeam('existing')
    await pickTeam('existing')
    assert.deepEqual(teamWrites, [])
    assert.deepEqual(reads, [])
    const change = { issueId: 'task', teamId: 'another', expectedTeamId: 'existing' }
    response = { ok: false, error: 'denied' }
    await pickTeam('another')
    assert.deepEqual(teamWrites, [change])
    assert.deepEqual(reads, [])
    assert.equal(row('team').menu.find(item => item.checked).id, 'existing')
    assert.equal(frame.rowsError, 'denied')
    response = null
    await pickTeam('another')
    assert.deepEqual(teamWrites, [change, change])
    assert.equal(row('team').menu.find(item => item.checked).id, 'another')
    assert.deepEqual(reads, ['viewer-list'])
  } finally { await dispose() }
})

test('clearing current delegation leaves historical Bot runs out of the Task delegate row', async () => {
  issue.metadata = { ...issue.metadata, delegate: null }
  const dispose = await mount()
  try {
    assert.equal(row('delegate'), undefined)
  } finally { await dispose() }
})

test('a saved Bot is the only displayed assignee before its first run when no member owns the Task', async () => {
  const dispose = await mount()
  try {
    assert.equal(row('assignee').value.text, 'Assigned bot')
    assert.equal(row('delegate'), undefined)
  } finally { await dispose() }
})

test('the assignee menu selects the effective owner and changes only the human assignment', async () => {
  const agent = { kind: 'agent', id: 'agent', name: 'Build Agent', image: null }
  const member = { kind: 'member', id: 'alice', name: 'Alice', image: null }
  const writes = []
  saveMetadata = input => writes.push(input.patch)
  optionsRead = { data: { members: [member], labels: [], isOwner: false } }
  for (const { assignee, delegate, fallback, selected } of [
    { assignee: null, delegate: agent, fallback: 'Build Agent', selected: 'Build Agent' },
    { assignee: member, delegate: agent, fallback: 'Build Agent', selected: 'Alice' },
    { assignee: member, delegate: null, fallback: 'unassigned', selected: 'Alice' },
    { assignee: null, delegate: null, fallback: 'unassigned', selected: 'unassigned' },
    { assignee: agent, delegate: null, fallback: 'Build Agent', selected: 'Build Agent' },
  ]) {
    issue.metadata = { ...issue.metadata, assignee, delegate }
    const dispose = await mount()
    try {
      await act(async () => row('assignee').onOpen())
      const choices = row('assignee').menu
      assert.deepEqual(choices.filter(choice => choice.checked).map(choice => choice.label), [selected])
      assert.deepEqual(choices.map(choice => choice.label), [fallback, 'Alice'])
      const [withoutMember, alice] = choices
      writes.length = 0
      if (assignee === member) {
        await act(async () => alice.onSelect())
        assert.deepEqual(writes, [])
        await act(async () => withoutMember.onSelect())
        assert.deepEqual(writes, [{ assignee: null }])
      } else {
        assert.equal(withoutMember.onSelect, undefined)
        await act(async () => alice.onSelect())
        assert.deepEqual(writes, [{ assignee: { kind: 'member', id: 'alice' } }])
      }
    } finally { await dispose() }
  }
})

test('the saved delegate is visible before its first run and favorites immediately adopt the server revision', async () => {
  issue.metadata = { ...issue.metadata, assignee: { kind: 'member', id: 'member', name: 'Assigned member', image: null } }
  const dispose = await mount()
  try {
    assert.equal(row('assignee').value.text, 'Assigned member')
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


test('a stale Task property write reloads the detail and keeps the draft for one explicit retry', async () => {
  const writes = []
  saveMetadata = async ({ revision, patch }) => {
    writes.push({ revision, patch })
    if (writes.length === 1) {
      issue = { ...issue, revision: issue.revision + 1, metadata: { ...issue.metadata, estimate: 13 } }
      return { error: 'issueOutdated' }
    }
    return { issue: { ...issue, revision: revision + 1, metadata: { ...issue.metadata, ...patch } } }
  }
  const dispose = await mount({ showDialogs: true })
  try {
    await act(async () => frame.menu.items.find(item => item.id === 'dueDate').onSelect())
    const field = document.querySelector('#issue-action-value')
    field.value = '2027-04-02'
    const submit = () => act(async () => field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    await submit()
    assert.deepEqual(reads, ['issue-detail'])
    assert.equal(writes.length, 1)
    assert.equal(document.querySelector('#issue-action-value'), field)
    assert.equal(field.value, '2027-04-02')
    await submit()
    assert.deepEqual(writes, [
      { revision: 3, patch: { dueDate: '2027-04-02' } },
      { revision: 4, patch: { dueDate: '2027-04-02' } },
    ])
    assert.equal(issue.metadata.estimate, 13)
    assert.equal(issue.metadata.dueDate, '2027-04-02')
  } finally { await dispose() }
})

test('inline and menu subtask creation refresh a stale parent and save once on explicit retry', async () => {
  for (const entry of ['inline', 'menu']) {
    const writes = []
    const startingRevision = issue.revision
    createChild = async input => {
      writes.push(input)
      if (writes.length === 1) {
        issue = { ...issue, revision: issue.revision + 1, priority: 'high' }
        return { error: 'issueOutdated' }
      }
      return { issue: child }
    }
    reads = []
    const dispose = await mount({ showDialogs: true })
    try {
      const title = 'Keep this subtask draft'
      let submit
      if (entry === 'menu') {
        await act(async () => frame.menu.items.find(item => item.id === 'createChild').onSelect())
        const field = document.querySelector('#issue-action-value')
        field.value = title
        submit = () => act(async () => field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
      } else {
        submit = () => act(async () => { await frame.subtasks.onCreate(title) })
      }
      await submit()
      assert.deepEqual(reads, ['issue-detail'], entry)
      assert.equal(writes.length, 1)
      if (entry === 'menu') assert.equal(document.querySelector('#issue-action-value').value, title)
      await submit()
      assert.deepEqual(writes, [startingRevision, startingRevision + 1].map(revision => ({
        id: issue.id, revision, kind: 'child', title, includeSubissues: false,
      })))
      assert.deepEqual(reads, ['issue-detail', 'revalidate-connections', 'viewer-list'])
      assert.equal(issue.priority, 'high')
      assert.notEqual(issue.id, child.id)
    } finally { await dispose() }
  }
})

test('a failed inline relation read does not block the independent menu form or its validation', async () => {
  connectionsError = new Error('relations unavailable')
  createChild = mock.fn(async input => input.title.trim() ? { issue: child } : { error: 'issueTitleInvalid' })
  const dispose = await mount({ showDialogs: true })
  try {
    assert.equal(frame.subtasks.disabled, true)
    assert.ok(frame.subtasks.failed)
    await act(async () => { assert.equal(await frame.subtasks.onCreate('keep this title'), false) })
    assert.equal(createChild.mock.callCount(), 0)
    await act(async () => frame.menu.items.find(item => item.id === 'createChild').onSelect())
    const field = document.querySelector('#issue-action-value')
    const submit = () => act(async () => field.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    field.value = '   '
    await submit()
    assert.equal(field.value, '   ')
    assert.ok(field.form.textContent.includes('issueTitleInvalid'))
    field.value = 'Valid title'
    await submit()
    assert.deepEqual(createChild.mock.calls.map(call => call.arguments[0].title), ['   ', 'Valid title'])
    assert.deepEqual(reads, ['revalidate-connections', 'viewer-list'])
  } finally { await dispose() }
})
