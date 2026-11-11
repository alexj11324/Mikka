import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { IssueView } from '../app/actions/issues'
import type { TaskDetailRow } from '../components/slots/task-detail-contract'

/**
 * The task page's property rows, as the layer receives them
 * (components/slots/task-detail-contract.ts). The layer draws whatever is in
 * `rows`; a property missing from that array is a property the page cannot show
 * and, if its only other route is the ⋯ menu, a control a person looks for and
 * does not find.
 *
 * These assertions are about reachability, not styling: they do not care which
 * glyph a row draws, only that the row exists, is not disabled, and that its
 * action reaches Mikka's own dialog or picker.
 */
const issueId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '20000000-0000-4000-8000-000000000001'
const owner = 'fixture-owner'
const at = (path: string) => new URL(`../${path}`, import.meta.url).href

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
let createRoot: typeof import('react-dom/client')['createRoot']
let FramedTask: typeof import('../components/workspace/task-detail-frame')['FramedTask']
let root: Root
let container: HTMLDivElement
/** The props the shared layer handed the frame on its last render. */
let frame: { rows: TaskDetailRow[]; words: Record<string, unknown> } | null
const requests: string[] = []
let stored: IssueView
/** The task's connections, as `listIssueConnections` returns them. */
let connectionRows: { id: string; identifier: string | null; title: string }[] = []

// The frame itself is drawn by the private layer; only what the shared code
// hands it is under test here. `Frame` is passed in as a prop, so no module mock
// is needed: this test supplies the frame and reads the rows it receives.
const none = () => null
// The frame pulls in the task's description history, members, thread panel and
// 验收, none of which is a property row. A module mock replaces every export,
// so each one lists all of its names; the hooks its siblings call are stubbed
// with the empty answers a task with no acceptance or thread gives.
for (const [file, exports] of [
  ['issue-description-history', { IssueDescriptionHistory: none }],
  ['issue-members', { IssueMembers: none }],
  ['issue-thread-panel', { IssueThreadPanel: none }],
  ['factory-acceptance', {
    useAcceptanceTasks: () => ({ data: [], error: null, mutate: async () => {} }),
    useThreadAcceptance: () => ({ data: null, error: null }),
    FactoryArtifactAcceptance: none, AcceptanceStateBadge: none, FactoryListError: none,
    FactoryAcceptance: none, FactoryAcceptancePanel: none,
  }],
] as const) mock.module(at(`components/workspace/${file}.tsx`), { namedExports: exports })
// The thread reads reach a server action that needs a request scope; a task with
// no threads answers empty, which is all the property rows need.
mock.module(at('components/workspace/issue-threads.tsx'), { namedExports: {
  issueThreadsKey: (id: string) => ['issue-threads', id],
  useIssueThreads: () => ({ data: [], error: null, mutate: async () => {} }),
  harnessLabel: (value: string) => value,
  useAgentActivity: () => ({ items: [], error: null, mark: null }),
  ThreadBotAvatar: none,
} })
// The team row reads two more server actions; a task in no team is the shape
// under test, so it answers that without a request.
mock.module(at('components/teams/issue-team-control.tsx'), { namedExports: {
  IssueTeamControl: none,
  useIssueTeam: () => ({ label: 'Team', currentLabel: 'No team', selected: null, data: '', unavailable: false, pending: false, failed: null, choices: [], setNext: () => {}, save: async () => true }),
} })
mock.module('next-intl', { namedExports: {
  useTranslations: (namespace = '') => Object.assign(
    (key: string, values?: Record<string, unknown>) => `${namespace}.${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`,
    { has: () => true },
  ),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '12/31', relativeTime: () => 'now' }),
  useNow: () => new Date('2026-11-11T12:00:00Z'),
} })
mock.module('sonner', { namedExports: { toast: { error: () => {}, success: () => {}, dismiss: () => {} } } })
mock.module(at('app/actions/issue-metadata.ts'), { namedExports: {
  getIssuePropertyOptions: async () => ({ members: [], projects: [], projectRecords: [], labels: [], isOwner: true }),
  updateIssueMetadata: async () => ({ error: 'issueMetadataInvalid' }),
} })
mock.module(at('app/actions/issue-operations.ts'), { namedExports: {
  // The task's connections as the page reads them; the parent test seeds one.
  listIssueConnections: async () => connectionRows.map(row => ({ ...row, status: 'todo', revision: 1, createdAt: '2026-11-11T08:00:00Z', metadata: { blockedByIds: [], relatedIds: [], parentId: null } })),
  updateIssueRelation: async () => ({ error: 'issueMetadataInvalid' }),
  createLinkedIssue: async () => ({ error: 'issueMetadataInvalid' }),
  setIssueDeleted: async () => ({ error: 'issueMetadataInvalid' }),
  toggleIssuePreference: async () => ({ error: 'issueMetadataInvalid' }),
} })
mock.module(at('app/actions/issues.ts'), { namedExports: {
  pollIssue: async () => ({ issue: structuredClone(stored), version: 'v', viewerId: owner }),
  pollIssueVersionSummaries: async () => ({ viewerId: owner, snapshot: { version: 'v', items: [] } }),
  listIssueVersions: async () => [],
  saveIssue: async () => ({ issue: structuredClone(stored) }),
  moveIssue: async () => ({ error: 'issueMoveInvalid' }),
  setIssueScope: async () => ({ error: 'issueScopeInvalid' }),
  promoteIssueToTeam: async () => ({ error: 'teamIssueAccessDenied' }),
} })

function issue(metadata: Record<string, unknown> = {}): IssueView {
  // The real defaults, as readIssueMetadata produces them: the page reads
  // favourite and subscriber lists on every render.
  return {
    id: issueId, userId: owner, title: 'Acceptance report', content: { type: 'doc' }, status: 'todo', priority: 'normal',
    revision: 1, identifier: 'ALEX-60', scope: 'personal', workspaceId,
    createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T08:00:00Z',
    metadata: {
      assignee: null, delegate: null, project: null, labels: [], pullRequests: [], parentId: null,
      blockedByIds: [], relatedIds: [], duplicateOfId: null, block: null, dueDate: null, estimate: null,
      favoriteUserIds: [], subscriberUserIds: [], deletedAt: null, ...metadata,
    },
  } as unknown as IssueView
}

before(async () => {
  for (const key of ['window', 'document', 'navigator', 'location', 'customElements', 'ShadowRoot', 'Text', 'DocumentFragment', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'Element', 'Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'InputEvent', 'CompositionEvent', 'FocusEvent', 'Event', 'CustomEvent', 'CSS'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FramedTask } = await import('../components/workspace/task-detail-frame'))
})

beforeEach(() => {
  frame = null; requests.length = 0; connectionRows = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => { await act(async () => { root.unmount() }); container.remove() })
after(() => { browser.close() })

/**
 * Mounts the shared task page with the layer's frame replaced, so `frame` holds
 * exactly the rows the layer would draw.
 */
async function mount(metadata: Record<string, unknown> = {}) {
  stored = issue(metadata)
  const noop = () => {}
  const props = {
    Frame: (p: { rows: TaskDetailRow[]; words: Record<string, unknown> }) => { frame = p; return null },
    rootRef: { current: null }, onKeyDown: noop, label: 'Acceptance report', preview: false, origin: '看板',
    navigation: { index: -1, total: 0, previous: null, next: null }, onClose: noop, onOpen: noop, onDeleted: noop,
    userId: owner, task: stored, title: 'Acceptance report', status: 'todo', priority: 'normal', liveWorkspaceId: workspaceId,
    saveLabel: '', saved: true, syncNotice: null,
    titleField: { value: 'Acceptance report', label: 'Title', readOnly: false, maxLength: 200, onChange: noop, onCompositionStart: noop, onCompositionEnd: noop, onBlur: noop, onKeyDown: noop },
    saveError: null, editor: () => null, acceptance: null, versions: [], historyFailed: null,
    agentActivity: { items: [], mark: null, failed: null }, documentTools: false,
    actionRequest: null, propertyRequest: null,
    requestAction: (kind: string) => requests.push(kind), requestProperty: (target: string) => requests.push(target),
    getCurrent: async () => stored, adopt: noop, onMetadataBusy: noop,
    onStatus: noop, onPriority: noop, onHistory: noop, onMembers: noop, onDocumentTools: noop,
    panel: null, wide: false, resize: { handle: null, width: 360, dragging: false }, dialogs: null,
  }
  const { SWRConfig } = await import('swr')
  const Frame = FramedTask as unknown as (p: typeof props) => ReactElement
  await act(async () => {
    root.render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <Frame {...props} />
    </SWRConfig>)
  })
  return props
}

const rowOf = (id: string) => frame!.rows.find(row => row.id === id)

test('a task with nothing set still offers a due date, an estimate and a parent', async () => {
  await mount({})
  for (const id of ['dueDate', 'estimate', 'parent']) {
    const row = rowOf(id)
    assert.ok(row, `${id} is offered when the task has no ${id}`)
    // `disabled` is `preview` (false on a real page), not "disabled": the row is pressable.
    assert.notEqual(row.disabled, true, `${id} can be pressed`)
    assert.ok(row.menu || row.onClick, `${id} has something to press`)
  }
})

test('the due date row opens Mikka’s date dialog whether or not a date is set', async () => {
  await mount({})
  assert.equal(rowOf('dueDate')!.value?.muted, true, 'an unset date reads as unset, not as a value')
  rowOf('dueDate')!.onClick!()
  assert.deepEqual(requests, ['dueDate'])

  requests.length = 0
  await mount({ dueDate: '2026-12-31' })
  assert.equal(rowOf('dueDate')!.value?.muted, undefined, 'a set date is not muted')
  assert.equal(rowOf('dueDate')!.value?.text, '12/31')
  rowOf('dueDate')!.onClick!()
  assert.deepEqual(requests, ['dueDate'])
})

test('an overdue date is still marked as overdue once the row is always shown', async () => {
  await mount({ dueDate: '2026-01-05' })
  assert.equal(rowOf('dueDate')!.value?.danger, true)
})

test('the estimate row opens Mikka’s estimate dialog whether or not one is set', async () => {
  await mount({})
  assert.equal(rowOf('estimate')!.value?.muted, true)
  rowOf('estimate')!.onClick!()
  assert.deepEqual(requests, ['estimate'])

  requests.length = 0
  await mount({ estimate: 0 })
  // 0 is a real estimate, not "no estimate": it must not fall into the unset branch.
  assert.equal(rowOf('estimate')!.value?.muted, undefined, 'an estimate of 0 is set')
  rowOf('estimate')!.onClick!()
  assert.deepEqual(requests, ['estimate'])
})

test('the parent row offers the picker, and only offers clearing once a parent exists', async () => {
  await mount({})
  assert.equal(rowOf('parent')!.value?.muted, true, 'no parent reads as unset')
  assert.deepEqual(rowOf('parent')!.menu!.map(item => item.id), ['set'], 'nothing to open or clear without a parent')
  rowOf('parent')!.menu![0].onSelect!()
  assert.deepEqual(requests, ['parent'], 'choosing a parent opens the task picker')
})

test('a set parent is named in its row and can be opened, replaced or cleared', async () => {
  // The parent arrives through the task's connections, not from its own row.
  connectionRows = [{ id: 'parent-id', identifier: 'ALEX-1', title: 'The parent' }]
  await mount({ parentId: 'parent-id' })
  const parent = rowOf('parent')
  assert.ok(parent, 'the parent row exists with a parent set')
  assert.equal(parent!.value?.muted, undefined, 'a set parent is not shown as unset')
  assert.equal(parent!.value?.text, 'ALEX-1 The parent', 'the row names the parent')
  assert.deepEqual(parent!.menu!.map(item => item.id), ['set', 'open', 'remove'], 'replace, open and clear are all offered')
  for (const item of parent!.menu!) assert.ok(item.onSelect, `${item.id} does something`)
})
