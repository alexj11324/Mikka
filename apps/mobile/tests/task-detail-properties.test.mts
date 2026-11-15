import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
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
mock.module('react-native', { namedExports: { View: box, ScrollView: box, StyleSheet: { create: (styles: unknown) => styles }, Pressable: box, Linking: { openURL: (url: string) => routes.push(url) } } })
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => routes.push(path) }), useLocalSearchParams: () => ({ id: 'task' }) } })
mock.module('react-native-safe-area-context', { namedExports: { useSafeAreaInsets: () => ({ bottom: 0 }) } })
mock.module('lucide-react-native', { namedExports: { CalendarClock: none, ChevronRight: none, Sparkles: none, UserRound: none } })
stub('components/Text.tsx', { Text: text })
stub('components/NavBar.tsx', { NavBar: none, underBar: {} })
stub('components/BarBackdrop.tsx', { useScrolledUnderBar: () => ({}) })
stub('components/icons.tsx', { BotAvatar: none, MachineIcon: none, Spinner: none })
stub('components/ReadNotice.tsx', { ReadNotice: none })
stub('components/GlassButton.tsx', { GlassButton: button })
stub('components/settings.tsx', { Row: button })
stub('components/Segmented.tsx', { Segmented: ({ options, onChange }: { options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
  options.map(option => createElement('button', { key: option.value, onClick: () => onChange(option.value) }, option.label)) })
stub('features/tasks/components/task-description.tsx', { TaskDescription: ({ body }: { body: string }) => createElement('p', null, body) })
stub('features/tasks/components/task-icons.tsx', { AttemptIcon: none, PriorityIcon: none, TaskStateIcon: none, priorityLabel: () => '', STATE_LABEL: {}, BOARD_LABEL: {} })
stub('features/tasks/components/agent-name.tsx', { AgentName: none })
stub('features/review/components/review-summary-row.tsx', { ReviewSummaryRow: none })
stub('lib/home.tsx', { useHome: () => ({}) })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0, SPACE: { block: 8 } })
stub('lib/web.ts', { openOnWeb: none })
stub('lib/push-route.ts', { taskLinkAttempt: () => undefined })
stub('lib/live-keys.ts', { taskDetailLive: none })
stub('features/tasks/model/task-presentation-read.ts', { readPresentedTask: none })
const at = '2026-11-15T06:00:00Z'
const comment = { kind: 'comment', actor: 'bot', id: 'b', threadId: 'discussion', messageId: 'b', author: 'Coordinator', body: 'Ready for acceptance', at }
const data = {
  task: { id: 'task', title: 'Ship one task', status: 'done', priority: 'normal', state: 'done', identifier: 'T-1', description: 'Human-facing brief' },
  live: { workspaceId: 'workspace' }, activity: [],
  timeline: [comment, { ...comment, actor: undefined, kind: 'reply', id: 'h', messageId: 'h', body: 'Human reply' }],
  work: { version: 1, linkedChats: [{ id: 'chat', title: 'Independent chat' }], connections: [],
    conversations: [{ id: 'thread', state: 'done', detail: { name: 'Implement fix', agent: 'Reviewer', createdAt: at, attemptIds: [] } }, { id: 'hidden', detail: null, ownerName: 'Private peer' }],
    pullRequests: [{ url: 'https://github.com/acme/test/pull/7', title: 'Proposed change', state: 'merged' }] },
}
stub('lib/useApi.ts', { useLiveApi: (path: string) => { requests.push(path); return { data } } })

test('the mounted Native task puts readable threads and pull requests before its brief and filters a human reply separately from Bot progress', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { TaskScreen } = await import('../features/tasks/screens/task-screen.tsx')
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div'), root = createRoot(host)
  const click = async (label: string) => {
    const target = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.startsWith(label))
    assert.ok(target, label)
    await act(async () => target.click())
  }
  try {
    await act(async () => root.render(createElement(TaskScreen)))
    const body = host.textContent ?? ''
    assert.ok(body.includes('Human-facing brief') && body.indexOf('Proposed change') < body.indexOf('Human-facing brief') && body.indexOf('Implement fix') < body.indexOf('Human-facing brief'))
    assert.ok(!body.includes('Private peer') && !body.includes(mobileMessages.IssueDetail.work.heading))
    for (const label of ['Independent chat', 'Implement fix', 'Proposed change']) await click(label)
    assert.deepEqual(routes, ['/groups/chat', '/thread/thread', 'https://github.com/acme/test/pull/7'])
    await click(mobileMessages.IssueDetail.frame.filterAgents)
    assert.match(host.textContent!, /Ready for acceptance/)
    assert.doesNotMatch(host.textContent!, /Human reply/)
    await click(mobileMessages.IssueDetail.frame.filterComments)
    assert.match(host.textContent!, /Human reply/)
    assert.deepEqual([...new Set(requests)], ['/api/mobile/tasks/task'])
  } finally { await act(async () => root.unmount()); await browser.close() }
})
