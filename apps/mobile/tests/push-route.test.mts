// A push about a task's thread opens the task, then that attempt (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { pushTarget, taskLinkAttempt } from '../lib/push-route.ts'

const run = '11111111-1111-4111-8111-111111111111'
const task = '22222222-2222-4222-8222-222222222222'
const bot = '33333333-3333-4333-8333-333333333333'

test('a thread of a task opens the task at that attempt', () => {
  assert.equal(pushTarget({ runId: run, issueId: task, botId: bot }), `/task/${task}?attempt=${run}`)
  assert.equal(pushTarget({ issueId: task }), `/task/${task}`)
})

test('a thread without a task opens the thread; a proposal its card; anything else the chat', () => {
  assert.equal(pushTarget({ runId: run }), `/thread/${run}`)
  assert.equal(pushTarget({ pendingActionId: run, issueId: task, botId: bot }), `/bots/${bot}?action=${run}`)
  assert.equal(pushTarget({ botId: bot }), `/bots/${bot}`)
  assert.equal(pushTarget({ issueId: 'not-a-uuid' }), '/bots/coordinator')
})

test('a task-scoped link opens only an attempt belonging to the authorized Task detail', () => {
  const detail = { task: { id: task }, activity: [{ kind: 'created' }, { kind: 'attempt', runId: run }] }
  assert.equal(taskLinkAttempt(task, run, detail), run)
  assert.equal(taskLinkAttempt(task, bot, detail), null)
  assert.equal(taskLinkAttempt(task, run, { ...detail, activity: [] }), null)
  assert.equal(taskLinkAttempt(bot, run, detail), undefined)
  assert.equal(taskLinkAttempt(task, run, null), undefined)
  assert.equal(taskLinkAttempt(task, undefined, detail), undefined)
})


test('a tapped bot notification binds its source workspace, refuses lost access and ignores a sign-out during its read', async () => {
  const source = 'a394408b-8b6b-4a50-b050-ad882e82690e'
  const active = '99e6cc12-d49b-43ea-8c41-798b54addad1'
  let actor: { id: string; user: { id: string } | null } = { id: 'account', user: { id: 'viewer' } }
  let currentWorkspace = active
  let read = async () => ({ botId: bot, workspaceId: source })
  const routes: string[] = [], alerts: string[] = [], reads: string[] = []
  class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
  mock.module('expo-router', { namedExports: { router: { canDismiss: () => false, navigate: () => {}, push: (href: string) => routes.push(href) } } })
  const stub = (file: string, namedExports: Record<string, unknown>) =>
    mock.module(new URL('../lib/' + file + '.ts', import.meta.url).href, { namedExports })
  stub('api', { ApiError, apiConnection: () => ({ account: actor }), api: async (path: string) => { reads.push(path); return read() },
    savedWorkspace: async () => currentWorkspace, saveWorkspace: async (id: string) => { currentWorkspace = id } })
  stub('config', { currentAccount: () => actor })
  stub('system-alert', { showSystemAlert: (message: string) => alerts.push(message) })
  const { openPush } = await import('../lib/navigate.ts')
  await openPush(pushTarget({ botId: bot }))
  assert.equal(currentWorkspace, source)
  assert.deepEqual(reads, [`/api/mobile/bots/${bot}?view=notification`])
  assert.deepEqual(routes, [`/bots/${bot}`])
  currentWorkspace = active
  read = async () => { throw new ApiError(404, 'botNotFound') }
  await openPush(pushTarget({ botId: bot }))
  assert.equal(currentWorkspace, active)
  assert.equal(alerts.length, 1)
  assert.equal(routes.length, 1)
  read = async () => { actor = { ...actor, user: null }; return { botId: bot, workspaceId: source } }
  await openPush(pushTarget({ botId: bot }))
  assert.equal(currentWorkspace, active)
  assert.equal(routes.length, 1)
  await openPush(pushTarget({ botId: bot }))
  assert.equal(reads.length, 3)
})
