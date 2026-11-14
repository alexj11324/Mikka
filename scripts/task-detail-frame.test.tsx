import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IssueView } from '../app/actions/issues'
import { readIssueMetadata } from '../lib/issue-metadata'
import type { TaskDetailFrameProps } from '../components/slots/task-detail-contract'
import type { FramedTaskProps } from '../components/workspace/task-detail-frame'

// Exercise the real layer adapter and canonical metadata. Only unrelated hooks,
// server boundaries and the drawing layer are fixtures; no response rewrites.
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
const noop = () => {}
const unexpected = () => { throw new Error('this read-only render must not call a server action') }
const translate = Object.assign((key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`, { has: () => true })
mock.module('next-intl', { namedExports: {
  useTranslations: () => translate, useLocale: () => 'en',
  useFormatter: () => ({ dateTime: () => '08:00', relativeTime: () => 'now' }), useNow: () => new Date('2026-11-10T08:00:00Z'),
} })
mock.module('swr', { defaultExport: () => ({ data: undefined, error: null, mutate: unexpected }), namedExports: { useSWRConfig: () => ({ mutate: unexpected }) } })
mock.module(at('app/actions/issue-metadata.ts'), { namedExports: { getIssuePropertyOptions: unexpected } })
mock.module(at('app/actions/issue-operations.ts'), { namedExports: { createLinkedIssue: unexpected } })
mock.module(at('components/nav/bot-avatar.tsx'), { namedExports: {
  BotAvatar: ({ seed }: { seed?: string }) => <i data-bot={seed ?? 'coordinator'} />,
  COORDINATOR_AVATAR: { seed: 'coordinator' },
} })
mock.module(at('components/teams/issue-team-control.tsx'), { namedExports: { useIssueTeam: () => ({ label: 'Team', currentLabel: 'None', choices: [], selected: '', unavailable: false, failed: '' }) } })
mock.module(at('components/workspace/issue-detail-actions.tsx'), { namedExports: { useIssueDetailMenu: () => ({ items: [], favorite: { on: false, label: 'Favorite', toggle: noop, disabled: false }, disabled: false, dialogs: null, copyLink: noop, subscribed: false, toggleSubscribed: noop }) } })
mock.module(at('components/workspace/issue-detail-properties.tsx'), { namedExports: { overdue: () => false } })
mock.module(at('components/workspace/issue-metadata-controls.tsx'), { namedExports: {
  IssueMetadataControls: () => null, useIssueMetadataSave: () => ({ pending: false, error: '', persist: unexpected, project: unexpected }),
} })
mock.module(at('components/workspace/issue-relations.tsx'), { namedExports: { useIssueConnections: () => ({ groups: [], children: [], rows: [], error: null, pending: false }) } })
mock.module(at('components/workspace/issue-scope-control.tsx'), { namedExports: { useIssueScope: () => ({ judgedByAgent: { label: 'Scope', shown: false }, current: 'Workspace', pending: false, options: [] }) } })
mock.module(at('components/workspace/issue-assignee-menu.tsx'), { namedExports: { AgentSphere: ({ name }: { name: string }) => <i data-agent={name} /> } })
let threads: { detail: { agentName: string; bot?: { seed: string } } }[] = []
mock.module(at('components/workspace/issue-threads.tsx'), { namedExports: { useIssueThreads: () => ({ data: threads }) } })
mock.module(at('components/workspace/issue-activity.tsx'), { namedExports: { useActivityDrafts: () => ({ body: '', setBody: noop, replyTo: null, setReplyTo: noop, reply: '', setReply: noop, submit: noop, sendReply: noop }) } })
mock.module(at('components/workspace/issue-pull-request-link.tsx'), { namedExports: { PullRequestStatus: () => null } })

const { FramedTask } = await import('../components/workspace/task-detail-frame')
const human = { kind: 'member' as const, id: 'fixture-owner', name: 'Owner', image: null }
const agent = { kind: 'agent' as const, id: 'fixture-worker', name: 'Current Worker', image: null }

function render(metadata: Record<string, unknown>, history: typeof threads = []) {
  threads = history
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
    Frame, rootRef: { current: null }, onKeyDown: noop, label: 'Task', preview: false, origin: 'Tasks',
    navigation: { index: 0, total: 1, onOpen: noop }, onClose: noop, onOpen: noop, onDeleted: noop,
    userId: human.id, task, title: task.title, status: task.status, priority: task.priority, liveWorkspaceId: null,
    saveLabel: '', saved: true, titleField: { value: task.title, label: 'Title', readOnly: false, maxLength: 500,
      onChange: noop, onCompositionStart: noop, onCompositionEnd: noop, onBlur: noop, onKeyDown: noop },
    saveError: null, syncNotice: null, editor: () => null, acceptance: null, versions: [], historyFailed: null,
    agentActivity: { rows: [], items: [], error: null, failed: null }, documentTools: false, actionRequest: null,
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

test('the explicit delegate wins over an unrelated historical Bot', () => {
  const { html, rows } = render({ assignee: human, delegate: agent }, [{ detail: { agentName: 'Previous Worker', bot: { seed: 'previous' } } }])
  assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
  assert.match(html, /data-agent="Current Worker"/)
  assert.doesNotMatch(html, /Previous Worker|data-bot="previous"/)
})

test('the explicit delegate uses its matching thread avatar while retaining human responsibility', () => {
  const { html, rows } = render({ assignee: human, delegate: agent }, [{ detail: { agentName: agent.name, bot: { seed: 'current' } } }])
  assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, human.name)
  assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
  assert.match(html, /data-bot="current"/)
})

test('the layer detail renders a legacy agent assignment after the real metadata parser normalizes it', () => {
  const { rows, task } = render({ assignee: agent })
  assert.equal(task.metadata.assignee, null)
  assert.deepEqual(task.metadata.delegate, agent)
  assert.equal(rows.find(row => row.id === 'assignee')?.value?.text, 'unassignedLabel')
  assert.equal(rows.find(row => row.id === 'delegate')?.value?.text, agent.name)
})

test('without an explicit delegate the existing Bot-thread fallback remains, while a Coordinator alone adds no row', () => {
  const fromBot = render({ assignee: human }, [{ detail: { agentName: 'History Worker', bot: { seed: 'history' } } }])
  assert.equal(fromBot.rows.find(row => row.id === 'delegate')?.value?.text, 'History Worker')
  assert.match(fromBot.html, /data-bot="history"/)
  const coordinator = render({ assignee: human }, [{ detail: { agentName: 'Coordinator' } }])
  assert.equal(coordinator.rows.some(row => row.id === 'delegate'), false)
  assert.equal(coordinator.rows.find(row => row.id === 'assignee')?.value?.text, human.name)
})
