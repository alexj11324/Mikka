import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const workspace = '10000000-0000-4000-8000-000000000001'
const bot = '20000000-0000-4000-8000-000000000002'
const other = '30000000-0000-4000-8000-000000000003'
const fixtures = [{ id: 'assigned', dispatchedBy: bot }, { id: 'someone-else', dispatchedBy: other }, { id: 'threadless' }]
  .map(task => ({ ...task, group: 'todo', state: 'todo', status: 'todo' }))
let route = bot
let home: { workspace: { id: string }; bots: { id: string; coordinator: boolean }[] } | null = null
const requests: string[] = []
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useLocalSearchParams: () => ({ id: route }), useRouter: () => ({}) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', Pressable: none, RefreshControl: none,
  FlatList: ({ data }: { data: { kind: string; task?: { id: string } }[] }) => data.flatMap(row => row.task ? [row.task.id + ' '] : []).join(''),
} })
mock.module('react-native-safe-area-context', { namedExports: { useSafeAreaInsets: () => ({ bottom: 0 }) } })
mock.module('lucide-react-native', { namedExports: { ChevronDown: none, ChevronRight: none } })
stub('components/NavBar.tsx', { NavBar: none, underBar: {} })
stub('components/Text.tsx', { Text: none })
stub('components/icons.tsx', { Spinner: none })
stub('components/ReadNotice.tsx', { ReadNotice: none })
stub('features/tasks/components/task-icons.tsx', { BOARD_LABEL: {}, GROUP_LABEL: {}, STATE_LABEL: {}, TaskGroupIcon: none, TaskStateIcon: none })
stub('features/tasks/model/task-presentation-read.ts', { readPresentedTasks: none })
stub('../../lib/hooks/use-task-continuation.ts', { useTaskContinuation: (items: unknown[]) => ({ items, hasMore: false }) })
stub('lib/api.ts', { ApiError: Error })
stub('lib/haptics.ts', { tap: none })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0, ROW_SURFACE_INSET: 0, SPACE: {} })
stub('lib/home.tsx', { useHome: () => ({ data: home }) })
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: (path: string | null) => {
  if (path) requests.push(path)
  const dispatchedBy = path && new URL(path, 'https://example.invalid').searchParams.get('dispatchedBy')
  const tasks = dispatchedBy ? fixtures.filter(task => task.dispatchedBy === dispatchedBy) : fixtures
  return { data: path ? { workspaceId: workspace, tasks } : null, reload: none }
} })
const { default: BotTasks } = await import('../app/bots/[id]/tasks.tsx')
const { TaskList } = await import('../features/tasks/components/task-list.tsx')

test('an unresolved Bot never reads or renders workspace Tasks; resolving the Bot requests only its assignments', () => {
  function render() { requests.length = 0; return renderToStaticMarkup(createElement(BotTasks)) }
  assert.doesNotMatch(render(), /assigned|someone-else|threadless/)
  assert.deepEqual(requests, [])
  home = { workspace: { id: workspace }, bots: [] }
  assert.doesNotMatch(render(), /assigned|someone-else|threadless/)
  assert.deepEqual(requests, [])
  home.bots = [{ id: bot, coordinator: true }]
  for (route of [bot, 'coordinator']) {
    const html = render()
    assert.match(html, /assigned/)
    assert.doesNotMatch(html, /someone-else|threadless/)
    assert.deepEqual(requests, ['/api/mobile/tasks?' + new URLSearchParams({ workspaceId: workspace, dispatchedBy: bot })])
  }
  requests.length = 0
  const html = renderToStaticMarkup(createElement(TaskList))
  assert.match(html, /assigned.*someone-else.*threadless/)
  assert.deepEqual(requests, ['/api/mobile/tasks'])
})
