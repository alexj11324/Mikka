import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IssueView } from '../app/actions/issues'
import type { IssueThread } from '../lib/issue-threads'
import { readIssueMetadata } from '../lib/issue-metadata'
import type { TaskDetailFrameProps } from '../components/slots/task-detail-contract'
import type { FramedTaskProps } from '../components/workspace/task-detail-frame'

// Exercise the real layer adapter and canonical metadata. Only unrelated hooks,
// server boundaries and the drawing layer are fixtures; no response rewrites.
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
const noop = () => {}
const unexpected = () => { throw new Error('this read-only render must not call a server action') }
const translate = Object.assign((key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`, { has: () => true })
mock.module('@/lib/intl/i18n-client', { namedExports: {
  useTranslations: () => translate, useLocale: () => 'en', useMessages: () => ({ IssueDetail: { work: { states: {} } }, GroupTask: { stage: {}, status: {} } }),
  useFormatter: () => ({ dateTime: () => '08:00', relativeTime: () => 'now' }), useNow: () => new Date('2026-11-10T08:00:00Z'),
} })
mock.module('swr', { defaultExport: () => ({ data: undefined, error: null, mutate: unexpected }), namedExports: { useSWRConfig: () => ({ mutate: unexpected }) } })
mock.module(at('app/actions/issue-metadata.ts'), { namedExports: { getIssuePropertyOptions: unexpected } })
mock.module(at('components/workspace/task-attachments.tsx'), { namedExports: { TaskAttachments: () => null } })
mock.module(at('components/teams/issue-team-control.tsx'), { namedExports: { useIssueTeam: () => ({ label: 'Team', currentLabel: 'None', choices: [], selected: '', unavailable: false, failed: '' }) } })
mock.module(at('components/workspace/issue-detail-actions.tsx'), { namedExports: { useIssueDetailMenu: () => ({ items: [], favorite: { on: false, label: 'Favorite', toggle: noop, disabled: false }, disabled: false, dialogs: null, copyLink: noop, subscribed: false, toggleSubscribed: noop }) } })
mock.module(at('components/workspace/issue-detail-properties.tsx'), { namedExports: { overdue: () => false } })
mock.module(at('components/workspace/issue-metadata-controls.tsx'), { namedExports: {
  AccessChangeDialog: () => null, IssueMetadataControls: () => null, useIssueMetadataSave: () => ({ pending: false, error: '', persist: unexpected, project: unexpected }),
} })
mock.module(at('components/workspace/issue-relations.tsx'), { namedExports: { useIssueConnections: () => ({ groups: [], children: [], rows: [], error: null, pending: false }) } })
mock.module(at('components/workspace/issue-scope-control.tsx'), { namedExports: { useTaskOwnershipRows: () => [] } })
mock.module(at('components/workspace/issue-assignee-menu.tsx'), { namedExports: { AgentSphere: ({ name }: { name: string }) => <i data-agent={name} /> } })
mock.module(at('components/workspace/issue-activity.tsx'), { namedExports: { useActivityDrafts: () => ({ body: '', setBody: noop, replyTo: null, setReplyTo: noop, reply: '', setReply: noop, submit: noop, sendReply: noop }) } })
mock.module(at('components/workspace/issue-pull-request-link.tsx'), { namedExports: { PullRequestStatus: () => null } })

const { FramedTask } = await import('../components/workspace/task-detail-frame')
const human = { kind: 'member' as const, id: 'fixture-owner', name: 'Owner', image: null }
const agent = { kind: 'agent' as const, id: 'fixture-worker', name: 'Current Worker', image: null }

function historicalRun(agentName: string, bot: boolean): IssueThread {
  return {
    id: 'historical-run', rootRunId: 'historical-run', latestRunId: 'historical-run', status: 'finished', stopping: false,
    createdAt: new Date('2026-11-09T08:00:00Z'), finishedAt: new Date('2026-11-09T08:05:00Z'),
    ownedByCurrentUser: true, ownerName: human.name, question: null, continuation: null, attempts: [],
    detail: { name: 'Historical run', agentName, harness: 'codex', summary: null, bot: bot ? { color: 'blue', shape: 'circle' } : null },
  }
}

function render(metadata: Record<string, unknown>, threads: IssueThread[] = [], locked = false) {
  let captured: TaskDetailFrameProps | undefined
  const Frame = (props: TaskDetailFrameProps) => {
    captured = props
    return <div>{props.rows.map(row => <div key={row.id} data-row={row.id} aria-label={row.value?.aria}>
      {row.value?.mark?.kind === 'node' ? row.value.mark.node : null}{row.value?.text}
    </div>)}</div>
  }
  const content = { type: 'doc', attrs: { mikka: metadata } }
  const task: IssueView = { id: '10000000-0000-4000-8000-000000000001', userId: human.id, title: 'Task', content,
    metadata: readIssueMetadata(content), status: 'todo', priority: 'normal', scope: 'workspace', scopeSetBy: 'user',
    workspaceId: '20000000-0000-4000-8000-000000000001', ownershipState: 'bound', scopeVersion: 1, scopeConfidence: null,
    linearSyncPolicy: 'disabled', linearSyncBlocked: false, linearTargetVerified: false,
    shortTitle: null, shortTitleFrom: null, issuedIdentifier: 'TEAM-1', projectId: null,
    revision: 1, identifier: 'TEAM-1', createdAt: new Date('2026-11-10T08:00:00Z'), updatedAt: new Date('2026-11-10T08:00:00Z') }
  const props: FramedTaskProps = {
    Frame, rootRef: { current: null }, onKeyDown: noop, label: 'Task', preview: false, locked, origin: 'Tasks',
    navigation: { index: 0, total: 1, onOpen: noop }, onClose: noop, onOpen: noop, onDeleted: noop,
    userId: human.id, task, title: task.title, status: task.status, priority: task.priority, liveWorkspaceId: null,
    saveLabel: '', saved: true, titleField: { value: task.title, label: 'Title', readOnly: false, maxLength: 500,
      onChange: noop, onCompositionStart: noop, onCompositionEnd: noop, onBlur: noop, onKeyDown: noop },
    saveError: null, syncNotice: null, editor: () => null, acceptance: null, versions: [], historyFailed: null,
    agentActivity: { threads, work: undefined, connections: undefined, history: undefined, openThread: unexpected, retry: unexpected, failed: null }, documentTools: false, actionRequest: null,
    propertyRequest: null, requestAction: noop, requestProperty: noop, getCurrent: async () => task, adopt: noop,
    onMetadataBusy: noop, onStatus: noop, onPriority: noop, onHistory: noop, onMembers: noop,
    onDocumentTools: noop, panel: null, wide: true, resize: { handle: null, width: 360, dragging: false }, dialogs: null,
  }
  const html = renderToStaticMarkup(<FramedTask {...props} />)
  assert.ok(captured)
  return { html, rows: captured.rows, task }
}

test('the layer detail keeps a human assignee and each explicit execution delegate without requiring a historical thread', () => {
  for (const kind of ['agent', 'bot', 'profile']) {
    const { html, rows } = render({ assignee: human, delegate: { ...agent, kind } })
    assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, human.name)
    assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
    assert.match(html, /aria-label="aria Owner"/)
    assert.match(html, /aria-label="delegatedTo Current Worker"/)
  }
})

test('historical run identities cannot replace an explicit delegate or its displayed mark', () => {
  for (const previousName of ['Previous Worker', agent.name]) {
    const { html, rows } = render({ assignee: human, delegate: agent }, [historicalRun(previousName, true)])
    assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, human.name)
    assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
    assert.match(html, /data-agent="Current Worker"/)
    assert.doesNotMatch(html, /Previous Worker/)
  }
})

test('the admitted execution delegate is the displayed work owner when a task has no human assignee', () => {
  for (const metadata of [{ assignee: agent }, { delegate: agent }]) {
    const { html, rows, task } = render(metadata)
    assert.equal(task.metadata.assignee, null)
    assert.deepEqual(task.metadata.delegate, agent)
    assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, agent.name)
    assert.equal(rows.some(row => row.id === 'delegate'), false)
    assert.match(html, /data-agent="Current Worker"/)
  }
})

test('historical Bot and Coordinator runs cannot assign or delegate a task', () => {
  for (const thread of [historicalRun('History Worker', true), historicalRun('Coordinator', false)]) {
    for (const [metadata, expectedOwner] of [[{ assignee: human }, human.name], [{}, 'unassignedLabel']] as const) {
      const { rows } = render(metadata, [thread])
      assert.equal(rows.some(row => row.id === 'delegate'), false)
      assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, expectedOwner)
    }
  }
})

test('a locked task shows its human and delegate without enabling reassignment', () => {
  const { rows } = render({ assignee: human, delegate: agent }, [], true)
  const ownerRow = rows.find(row => row.id === 'assignee')
  assert.equal(ownerRow?.value?.text, human.name)
  assert.equal(ownerRow?.disabled, true)
  assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
})
