// A tapped push goes to the task opener only with a full task target; every other push keeps its entry (#1659 item 4).
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const account = { id: '1', user: { id: 'user-1' }, server: { url: 'https://cloud.example/mikka' } }
let tap: (response: unknown) => void = () => {}
mock.module('react-native', { namedExports: { AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'ios' } } })
mock.module('expo-constants', { defaultExport: { expoConfig: { extra: { eas: { projectId: 'fixture-project' } } } } })
mock.module('expo-device', { namedExports: { isDevice: true, deviceName: 'Fixture iPhone' } })
mock.module('expo-notifications', { namedExports: {
  DEFAULT_ACTION_IDENTIFIER: 'default', setNotificationHandler() {}, getPermissionsAsync: async () => ({ status: 'denied' }),
  getLastNotificationResponseAsync: async () => null, clearLastNotificationResponseAsync: async () => undefined,
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => { tap = listener; return { remove() {} } },
} })
mock.module('expo-secure-store', { namedExports: { getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { apiConnection: () => ({ account }), api: async () => undefined } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => account, onServerChange: () => {} } })
mock.module(new URL('../lib/push-state.ts', import.meta.url).href, { namedExports: { pushState: () => 'unknown', setPushState: () => {} } })
const { watchPushes } = await import('../lib/push.ts')
const { taskPushOpener } = await import('../lib/task-push.ts')

const alpha = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const task = '22222222-2222-4222-8222-222222222222'
const bot = '33333333-3333-4333-8333-333333333333'
let n = 0
const response = (data: Record<string, unknown>) => ({ actionIdentifier: 'default', notification: { request: { identifier: `push-${++n}`, content: { data: { serverUrl: account.server.url, userId: account.user.id, ...data } } } } })

test('a full task push is confirmed through the task opener; generic and privacy-mode pushes keep the old entry', () => {
  const opened: string[] = [], tasks: unknown[] = []
  let refused = 0
  const stop = watchPushes(href => { opened.push(href) }, target => { tasks.push(target) }, () => { refused++ })
  tap(response({ botId: bot, workspaceId: alpha, issueId: task }))
  tap(response({ botId: bot }))
  tap(response({}))
  stop()
  assert.deepEqual(tasks, [{ workspaceId: alpha, issueId: task, runId: null }])
  assert.deepEqual(opened, [`/bots/${bot}`, '/bots/coordinator'])
  assert.equal(refused, 0)
})

test('{workspaceId:"bad", issueId:<valid>} and {workspaceId:<valid>, issueId:"bad"} are refused: nothing opens', () => {
  const opened: string[] = [], tasks: unknown[] = []
  let refused = 0
  const stop = watchPushes(href => { opened.push(href) }, target => { tasks.push(target) }, () => { refused++ })
  tap(response({ botId: bot, workspaceId: 'bad', issueId: task }))
  tap(response({ botId: bot, workspaceId: alpha, issueId: 'bad' }))
  stop()
  assert.equal(refused, 2)
  assert.deepEqual(opened, [])
  assert.deepEqual(tasks, [])
})

test('a legacy task push without a workspaceId field still opens /task/{id}', () => {
  const opened: string[] = []
  let refused = 0
  const stop = watchPushes(href => { opened.push(href) }, () => assert.fail('no task target'), () => { refused++ })
  tap(response({ botId: bot, issueId: task }))
  stop()
  assert.deepEqual(opened, [`/task/${task}`])
  assert.equal(refused, 0)
})

test('a refused push shows the feedback through the opener and opens nothing', () => {
  const feedback: unknown[] = [], opened: string[] = []
  const opener = taskPushOpener({ current: async () => assert.fail('nothing to confirm'), save: async () => assert.fail('nothing to save'),
    owner: () => ({ account: 'A', context: 0 }), open: href => { opened.push(href) }, unconfirmed: retry => { feedback.push(retry) } })
  const stop = watchPushes(href => { opened.push(href) }, target => { void opener.open(target) }, () => { opener.invalid() })
  tap(response({ botId: bot, workspaceId: 'bad', issueId: task }))
  tap(response({ botId: bot, workspaceId: alpha, issueId: 'bad' }))
  stop()
  assert.deepEqual(feedback, [undefined, undefined], 'feedback without a retry: there is nothing valid to try again')
  assert.deepEqual(opened, [])
})
