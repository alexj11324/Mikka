// A tapped task push opens the task in its own workspace (#1659 item 4): capture, confirm the selection, then open.
import assert from 'node:assert/strict'
import test from 'node:test'
import { pushTarget, pushTaskTarget } from '../lib/push-route.ts'
import { readTaskInWorkspace, taskPushHref, taskPushOpener, TaskWorkspaceRefused, WORKSPACE_SELECTION_HEADER } from '../lib/task-push.ts'

const alpha = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const beta = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const gamma = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const task = '22222222-2222-4222-8222-222222222222'
const run = '11111111-1111-4111-8111-111111111111'
const bot = '33333333-3333-4333-8333-333333333333'
const server = { serverUrl: 'https://cloud.example/mikka', userId: 'user-1' }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** The server's selection and the app's context, as lib/api.ts saveWorkspace and GET /api/mobile/settings see them. */
function workspaces(selected: string, members = [alpha, beta, gamma]) {
  const state = { cookie: selected, server: selected, context: 0, saves: [] as string[], opened: [] as string[], reads: 0, feedback: [] as ((() => void) | undefined)[] }
  const deps = {
    current: async () => { state.reads++; return state.server },
    save: async (id: string, owner: { account: string; context: number }) => {
      if (owner.account !== 'A' || owner.context !== state.context) return null
      state.saves.push(id); state.cookie = id; state.server = members.includes(id) ? id : state.server
      return ++state.context
    },
    owner: () => ({ account: 'A', context: state.context }),
    open: (href: string) => { state.opened.push(href) },
    unconfirmed: (retry?: () => void) => { state.feedback.push(retry) },
  }
  return { state, deps }
}

test('capture: a full task push names its workspace, task and attempt', () => {
  assert.deepEqual(pushTaskTarget({ ...server, botId: bot, workspaceId: alpha, issueId: task, runId: run }), { workspaceId: alpha, issueId: task, runId: run })
  assert.deepEqual(pushTaskTarget({ ...server, workspaceId: alpha.toUpperCase(), issueId: task }), { workspaceId: alpha, issueId: task, runId: null })
  assert.equal(taskPushHref({ workspaceId: alpha, issueId: task, runId: run }), `/task/${task}?workspace=${alpha}&attempt=${run}`)
  assert.equal(taskPushHref({ workspaceId: alpha, issueId: task, runId: null }), `/task/${task}?workspace=${alpha}`)
})

test('generic pushes and privacy-mode reminders keep their old entry and never guess a task or workspace', () => {
  const privacy = { ...server, botId: bot }
  assert.equal(pushTaskTarget(privacy), null)
  assert.equal(pushTarget(privacy), `/bots/${bot}`)
  assert.equal(pushTaskTarget(server), null)
  assert.equal(pushTarget(server), '/bots/coordinator')
  assert.equal(pushTaskTarget({ ...server, targetWorkspaceId: alpha, issueId: task }), null, 'only the field the server sends counts')
  assert.equal(pushTaskTarget({ ...server, workspaceId: alpha, issueId: task, pendingActionId: run, botId: bot }), null, 'a proposal keeps its chat')
  assert.equal(pushTarget({ ...server, runId: run }), `/thread/${run}`)
})

test('legacy: a task push without a workspaceId field keeps the old /task entry, with no workspace guessed', () => {
  assert.equal(pushTaskTarget({ ...server, botId: bot, issueId: task }), null)
  assert.equal(pushTarget({ ...server, botId: bot, issueId: task }), `/task/${task}`)
  assert.equal(pushTarget({ ...server, issueId: task, runId: run }), `/task/${task}?attempt=${run}`)
})

test('an explicit but invalid task target is refused, never degraded into the legacy entry', () => {
  assert.equal(pushTaskTarget({ ...server, workspaceId: 'bad', issueId: task }), 'invalid')
  assert.equal(pushTaskTarget({ ...server, workspaceId: alpha, issueId: 'bad' }), 'invalid')
  assert.equal(pushTaskTarget({ ...server, workspaceId: alpha }), 'invalid', 'a workspace without a task')
  assert.equal(pushTaskTarget({ ...server, workspaceId: '', issueId: task }), 'invalid')
  assert.equal(pushTaskTarget({ ...server, workspaceId: null, issueId: task, runId: run }), 'invalid')
  assert.equal(pushTaskTarget({ ...server, workspaceId: 'bad', issueId: task, pendingActionId: run, botId: bot }), null, 'a proposal is classified first')
})

test('an invalid target shows the feedback without a retry and supersedes an older tap', async () => {
  const { state, deps } = workspaces(beta)
  const first = deferred<string>()
  const opener = taskPushOpener({ ...deps, current: () => first.promise })
  const older = opener.open({ workspaceId: alpha, issueId: task, runId: null })
  assert.equal(opener.invalid(), 'refused')
  first.resolve(beta)
  assert.equal(await older, 'superseded')
  assert.deepEqual(state.opened, [])
  assert.deepEqual(state.feedback, [undefined])
})

test('Beta is selected and a valid push in Alpha switches to Alpha, confirms it fresh, then opens the task', async () => {
  const { state, deps } = workspaces(beta)
  const { open } = taskPushOpener(deps)
  assert.equal(await open({ workspaceId: alpha, issueId: task, runId: run }), 'opened')
  assert.deepEqual(state.saves, [alpha])
  assert.equal(state.reads, 2, 'the selection is read before the switch and confirmed after it')
  assert.equal(state.cookie, alpha)
  assert.deepEqual(state.opened, [`/task/${task}?workspace=${alpha}&attempt=${run}`])
})

test('a push in the workspace already selected is confirmed fresh and opens without a switch', async () => {
  const { state, deps } = workspaces(alpha)
  assert.equal(await taskPushOpener(deps).open({ workspaceId: alpha, issueId: task, runId: null }), 'opened')
  assert.deepEqual(state.saves, [])
  assert.equal(state.reads, 1)
  assert.deepEqual(state.opened, [`/task/${task}?workspace=${alpha}`])
})

test('a revoked or invalid workspace is refused: the old selection comes back and nothing opens', async () => {
  const { state, deps } = workspaces(beta, [beta])
  assert.equal(await taskPushOpener(deps).open({ workspaceId: alpha, issueId: task, runId: null }), 'refused')
  assert.deepEqual(state.saves, [alpha, beta], 'the switch restores Beta, it never opens another workspace')
  assert.equal(state.cookie, beta)
  assert.deepEqual(state.opened, [])
  assert.equal(state.feedback.length, 1, 'the stop shows 无法确认工作区 once')
})

test('the feedback offers a retry that runs the same confirmation again', async () => {
  const { state, deps } = workspaces(beta, [beta])
  const { open } = taskPushOpener(deps)
  assert.equal(await open({ workspaceId: alpha, issueId: task, runId: null }), 'refused')
  assert.deepEqual(state.opened, [], 'the feedback does not change the stop')
  // Access is granted meanwhile; 重试 confirms Alpha fresh and opens the task.
  deps.save = async (id: string) => { state.saves.push(id); state.cookie = id; state.server = id; return ++state.context }
  const retry = state.feedback[0]
  assert.ok(retry)
  retry()
  await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done))
  assert.deepEqual(state.opened, [`/task/${task}?workspace=${alpha}`])
})

test('signed out (401 authRequired) stops without feedback: the sign-in handling takes over', async () => {
  const { state, deps } = workspaces(beta)
  const authRequired = async () => { throw Object.assign(new Error('authRequired'), { status: 401, code: 'authRequired' }) }
  assert.equal(await taskPushOpener({ ...deps, current: authRequired }).open({ workspaceId: alpha, issueId: task, runId: null }), 'signedOut')
  assert.deepEqual(state.saves, [])
  assert.deepEqual(state.opened, [])
  assert.deepEqual(state.feedback, [])
  let reads = 0
  const lostWhileSwitching = async () => { if (++reads === 1) return beta; throw Object.assign(new Error('authRequired'), { status: 401 }) }
  assert.equal(await taskPushOpener({ ...deps, current: lostWhileSwitching }).open({ workspaceId: alpha, issueId: task, runId: null }), 'signedOut')
  assert.deepEqual(state.opened, [])
  assert.deepEqual(state.feedback, [])
})

test('an unreadable selection (offline) stops before switching or opening and shows the feedback', async () => {
  const { state, deps } = workspaces(beta)
  assert.equal(await taskPushOpener({ ...deps, current: async () => { throw new Error('timeout') } }).open({ workspaceId: alpha, issueId: task, runId: null }), 'refused')
  assert.deepEqual(state.saves, [])
  assert.deepEqual(state.opened, [])
  assert.equal(state.feedback.length, 1)
})

test('a selection that moves while the switch is confirmed stops the open', async () => {
  const { state, deps } = workspaces(beta)
  const confirm = deferred<string>()
  let reads = 0
  const { open } = taskPushOpener({ ...deps, current: async () => (++reads === 1 ? beta : confirm.promise) })
  const pending = open({ workspaceId: alpha, issueId: task, runId: null })
  await new Promise(done => setImmediate(done))
  // The person picks Gamma in 设置 › 工作区 meanwhile.
  state.cookie = gamma; state.server = gamma; state.context++
  confirm.resolve(alpha)
  assert.equal(await pending, 'stale')
  assert.deepEqual(state.opened, [])
  assert.deepEqual(state.saves, [alpha], 'no rollback is written over the person\'s pick')
  assert.equal(state.cookie, gamma)
  assert.deepEqual(state.feedback, [])
})

test('a newer tap supersedes an older one still confirming', async () => {
  const { state, deps } = workspaces(beta)
  const first = deferred<string>()
  let reads = 0
  const { open } = taskPushOpener({ ...deps, current: async () => (++reads === 1 ? first.promise : state.server) })
  const older = open({ workspaceId: alpha, issueId: task, runId: null })
  const newer = open({ workspaceId: gamma, issueId: task, runId: null })
  first.resolve(beta)
  assert.equal(await older, 'superseded')
  assert.equal(await newer, 'opened')
  assert.deepEqual(state.opened, [`/task/${task}?workspace=${gamma}`])
})

test('the task read sends the selected workspace as x-mikka-workspace-id and keeps the server\'s refusal', async () => {
  const sent: Record<string, string>[] = []
  const detail = await readTaskInWorkspace(task, alpha, {
    selected: async () => alpha, context: () => 0,
    read: async (path, headers) => { sent.push(headers); assert.equal(path, `/api/mobile/tasks/${task}`); return { task: { id: task } } },
  })
  assert.deepEqual(detail, { task: { id: task } })
  assert.deepEqual(sent, [{ [WORKSPACE_SELECTION_HEADER]: alpha }])
  const refusal = Object.assign(new Error('issueNotFound'), { status: 404, code: 'issueNotFound' })
  await assert.rejects(readTaskInWorkspace(task, alpha, { selected: async () => alpha, context: () => 0, read: async () => { throw refusal } }), refusal)
})

test('a task read whose selection is not the confirmed workspace is refused without a request', async () => {
  let requested = false
  await assert.rejects(readTaskInWorkspace(task, alpha, { selected: async () => beta, context: () => 0, read: async () => { requested = true } }), TaskWorkspaceRefused)
  await assert.rejects(readTaskInWorkspace(task, alpha, { selected: async () => null, context: () => 0, read: async () => { requested = true } }), TaskWorkspaceRefused)
  assert.equal(requested, false)
})

test('a stale task response during a switch is dropped, never shown in the new workspace', async () => {
  let selected = alpha, context = 0
  const response = deferred<{ task: { id: string; workspace: string } }>()
  const pending = readTaskInWorkspace(task, alpha, { selected: async () => selected, context: () => context, read: () => response.promise })
  await new Promise(done => setImmediate(done))
  selected = beta; context++
  response.resolve({ task: { id: task, workspace: 'alpha' } })
  await assert.rejects(pending, TaskWorkspaceRefused)
})
