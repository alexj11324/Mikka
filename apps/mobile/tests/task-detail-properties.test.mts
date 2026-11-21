import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mobileMessages } from '../lib/messages.ts'

const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
const routes: string[] = []
const requests: string[] = []
const box = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
const button = ({ label, detail, onPress }: { label: string; detail?: string; onPress?: () => void }) =>
  createElement('button', { onClick: onPress }, label, detail ? ' ' + detail : '')
const text = ({ children, onPress }: { children: ReactNode; onPress?: () => void }) =>
  createElement(onPress ? 'button' : 'span', { onClick: onPress }, children)
const pressable = ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
  createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children)
mock.module('react-native', { namedExports: { View: box, ScrollView: box, StyleSheet: { create: (styles: unknown) => styles }, Pressable: pressable, Linking: { openURL: (url: string) => routes.push(url) } } })
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => routes.push(path) }), useLocalSearchParams: () => ({ id: 'task' }) } })
mock.module('react-native-safe-area-context', { namedExports: { useSafeAreaInsets: () => ({ bottom: 0 }) } })
const icons = { namedExports: Object.fromEntries(['ChartNoAxesColumn', 'ChevronRight', 'Circle', 'CircleUserRound', 'Flag', 'GitBranch', 'GitMerge', 'GitPullRequest',
  'GitPullRequestClosed', 'GitPullRequestDraft', 'Link', 'ListTree', 'MessageSquare', 'MessagesSquare', 'Sparkles', 'UserRound'].map(name => [name, ({ color }: { color?: string }) => createElement('i', { 'data-icon': name, 'data-color': color })])) }
mock.module('lucide-react-native', icons)
// The screen is loaded through require, which picks the package's CommonJS entry; where that differs from the ESM one, mock it too.
const lucideMain = pathToFileURL(createRequire(new URL('../package.json', import.meta.url)).resolve('lucide-react-native')).href
if (lucideMain !== import.meta.resolve('lucide-react-native')) mock.module(lucideMain, icons)
stub('components/Text.tsx', { Text: text })
stub('components/NavBar.tsx', { NavBar: none, underBar: {} })
stub('components/BarBackdrop.tsx', { useScrolledUnderBar: () => ({}) })
stub('components/icons.tsx', { Spinner: none })
stub('components/ReadNotice.tsx', { ReadNotice: none })
stub('components/GlassButton.tsx', { GlassButton: button })
stub('components/settings.tsx', { Row: button })
stub('components/Segmented.tsx', { Segmented: ({ options, onChange }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
  options.map(option => createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)) })
stub('features/tasks/components/task-description.tsx', { TaskDescription: ({ body }: { body: string }) => createElement('p', null, body) })
stub('features/tasks/components/task-icons.tsx', { AttemptIcon: ({ result }: { result: string }) => createElement('i', { 'data-result': result }), PriorityIcon: none, TaskStateIcon: none, priorityLabel: (priority: string) => mobileMessages.Issue.priority[priority as 'normal'], BOARD_LABEL: mobileMessages.MobileCore.board })
stub('features/tasks/components/agent-name.tsx', { AgentName: none })
stub('features/review/components/review-summary-row.tsx', { ReviewSummaryRow: none })
stub('lib/home.tsx', { useHome: () => ({}) })
stub('lib/theme.ts', { colors: { prOpen: 'green', merged: 'purple', danger: 'red', tertiary: 'grey' }, LIST_INSET: 0, SPACE: { block: 8 } })
stub('lib/web.ts', { openOnWeb: none })
stub('lib/push-route.ts', { taskLinkAttempt: () => undefined })
stub('lib/live-keys.ts', { taskDetailLive: none })
stub('features/tasks/model/task-presentation-read.ts', { readPresentedTask: none })
const at = '2026-11-15T06:00:00Z'
const later = '2026-11-15T07:00:00Z'
const agent = '00000000-0000-4000-8000-0000000000a1'
const history = (id: string, when: string, event: Record<string, unknown>) => ({ kind: 'history', id: `history:${id}`, at: when, event: { id, at: when, ...event } })
const comment = { kind: 'comment', actor: 'bot', id: 'b', threadId: 'discussion', messageId: 'b', author: 'Coordinator', body: 'Ready for acceptance', at: later }
const data = {
  task: { id: 'task', title: 'Ship one task', status: 'doing', priority: 'normal', state: null, identifier: 'T-1', description: 'Human-facing brief', workOwner: null,
    factoryTaskId: '00000000-0000-4000-8000-0000000000f1', bot: { id: 'bot', name: 'Builder Bot', color: 'blue', shape: 'circle' }, agent: { harness: 'codex', model: 'gpt' } },
  live: { workspaceId: 'workspace' }, activity: [{ kind: 'created', by: 'Older name', createdAt: at }],
  factoryEvents: [{ kind: 'evidence', id: 'evidence:00000000-0000-4000-8000-0000000000f1:receipt', at: later, factoryTaskId: '00000000-0000-4000-8000-0000000000f1', sourceId: 'receipt',
    evidenceKind: 'acceptance', title: 'Acceptance report', attemptId: null, runId: 'thread', candidateId: null, artifactId: null, version: 1 }],
  timeline: [
    history('created', at, { kind: 'created', actor: { type: 'user', id: 'u', name: 'Alex' } }),
    history('moved', '2026-11-15T06:30:00Z', { kind: 'status', status: 'doing', actor: { type: 'agent', id: agent, name: 'Codex' } }),
    history('renamed', '2026-11-15T06:40:00Z', { kind: 'priority', priority: 'high', actor: { type: 'agent', id: 'another-agent', name: 'Claude Code' } }),
    history('system', '2026-11-15T06:50:00Z', { kind: 'description', actor: null }),
    comment, { ...comment, actor: undefined, kind: 'reply', id: 'h', messageId: 'h', body: 'Human reply' }],
  work: { version: 1, linkedChats: [{ id: 'chat', title: 'Independent chat' }],
    connections: [{ id: 'parent', identifier: 'T-0', title: 'Parent task', kinds: ['parent'] }, { id: 'blocker', identifier: 'T-9', title: 'Blocking task', kinds: ['blockedBy'] }],
    conversations: [{ id: 'thread', state: 'done', stopping: false, detail: { name: 'Implement fix', agent: 'Codex', agentId: agent, createdAt: at, attemptIds: [] } },
      { id: 'untitled', state: 'running', stopping: false, detail: { name: '', agent: 'Codex', createdAt: '2026-11-16T00:00:00Z', attemptIds: [] } },
      { id: 'hidden', detail: null, ownerName: 'Private peer' }],
    pullRequests: [{ url: 'https://github.com/acme/test/pull/7', title: 'Proposed change', state: 'merged' }, { url: 'https://github.com/acme/test/pull/8', title: 'Follow-up', state: 'open' }] },
}
stub('lib/useApi.ts', { useLiveApi: (path: string) => { requests.push(path); return { data } } })

test('the Native task lists Capy\'s properties in one column and its activity as one actor-first sentence per event', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { TaskScreen } = await import('../features/tasks/screens/task-screen.tsx')
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div'), root = createRoot(host)
  const click = async (label: string) => {
    const target = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes(label))
    assert.ok(target, label)
    await act(async () => target.click())
  }
  const { Metadata, Issue, Workspace, MobileCore, IssueDetail } = mobileMessages
  try {
    await act(async () => root.render(createElement(TaskScreen)))
    const body = host.textContent ?? ''
    // Capy's order: parent, status, priority, assignee, creator, pull requests, threads, then the other relations, all before the brief.
    const order = [Metadata.relations.groupLabel.parent, Issue.statusLabel, Issue.priorityLabel, Metadata.property.assignee, Metadata.property.createdBy,
      Metadata.property.pullRequestMany, Metadata.property.threadMany, Metadata.relations.groupLabel.blockedBy, 'Human-facing brief']
    const positions = order.map(label => body.indexOf(label))
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)), JSON.stringify(positions))
    assert.ok(body.includes(MobileCore.board.doing) && body.includes(Metadata.assignee.unassignedLabel))
    assert.ok(body.includes(Metadata.property.createdBy + 'Alex'), 'the creator is the first revision\'s actor')
    // A PR line is its coloured mark, repo#n and the title, with no state word.
    assert.ok(body.includes('test#7 Proposed change') && body.includes('test#8 Follow-up'))
    assert.ok(!body.includes(IssueDetail.work.states.merged) && !body.includes(IssueDetail.work.states.open))
    const marks = Array.from(host.querySelectorAll('[data-icon="GitMerge"], [data-icon="GitPullRequest"]')).map(node => node.getAttribute('data-color'))
    assert.ok(marks.includes('purple') && marks.includes('green'))
    // Threads: each readable one with its status mark and title; an untitled one says so; a private one is not listed.
    assert.ok(body.includes('Implement fix') && body.includes(Workspace.activity.untitledThread) && !body.includes('Private peer'))
    assert.ok(host.querySelector('[data-result="done"]') && host.querySelector('[data-result="running"]'))
    // No 工作 section, no Bot / Agent chips, no Factory evidence row.
    assert.ok(!body.includes(IssueDetail.work.heading) && !body.includes('Builder Bot') && !body.includes('Acceptance report'))
    // Activity: a person by name, an Agent by its thread's title (never its name), no single thread → untitled, no actor → Mikka.
    assert.ok(body.includes('Alex ' + Workspace.activity.created.replace('{code}', 'T-1')))
    assert.ok(body.includes('Implement fix ' + Workspace.activity.moved.replace('{code}', 'T-1').replace('{status}', Issue.status.doing)))
    assert.ok(body.includes(Workspace.activity.untitledThread + ' ' + Workspace.activity.setPriority.replace('{priority}', Issue.priority.high)))
    assert.ok(body.includes(Workspace.activity.system + ' ' + Workspace.activity.editedDescription))
    assert.ok(!body.includes('Codex') && !body.includes('Claude Code'), 'an Agent is never named')
    assert.ok(!body.includes('Older name'), 'the timeline\'s creation replaces the older server\'s line')
    for (const label of ['T-0', 'Independent chat', 'Implement fix', 'test#7']) await click(label)
    assert.deepEqual(routes, ['/task/parent', '/groups/chat', '/thread/thread', 'https://github.com/acme/test/pull/7'])
    await click(IssueDetail.frame.filterAgents)
    assert.match(host.textContent!, /Ready for acceptance/)
    assert.doesNotMatch(host.textContent!, /Human reply/)
    await click(IssueDetail.frame.filterComments)
    assert.match(host.textContent!, /Human reply/)
    assert.deepEqual([...new Set(requests)], ['/api/mobile/tasks/task'])
  } finally { await act(async () => root.unmount()); await browser.close() }
})
