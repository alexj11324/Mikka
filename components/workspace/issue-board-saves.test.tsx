import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { listIssues } from '@/app/actions/issues'
import type { TaskBlock } from '@/lib/task-blocked'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
const task = { id: 'task', status: 'doing', priority: 'normal', revision: 6, metadata: { block: null } } as Issue
const lost = () => Promise.reject(new Error('Connection closed before the reply'))
const move = mock.fn<() => Promise<unknown>>(lost)
const read = mock.fn<(id: string) => Promise<unknown>>(lost)
const refresh = mock.fn(async () => {})
const error = mock.fn((_message: string) => {})
const translate = Object.assign((key: string, values?: { status: string }) => values ? `${key}:${values.status}` : key, { has: (key: string) => !key.startsWith('status.') })
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module('sonner', { namedExports: { toast: Object.assign(() => {}, { dismiss() {}, error }) } })
mock.module('@/app/actions/issues', { namedExports: { moveIssue: move, changeIssuePriority: move, getIssue: read } })
mock.module('@/app/actions/issue-operations', { namedExports: { setIssueDeleted: move } })
mock.module('@/app/actions/issue-metadata', { namedExports: { updateIssueMetadata: move } })
mock.module('@/components/blocks/kanban-board-1/components/kanban-board', { namedExports: { KanbanBoard: () => null } })

const window = new Window()
let root: Root
let useSaves: typeof import('./issue-board')['useIssueBoardSaves']
let saves: ReturnType<typeof useSaves>
before(async () => {
  for (const key of ['window', 'document', 'navigator'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ useIssueBoardSaves: useSaves } = await import('./issue-board'))
})
beforeEach(async () => {
  read.mock.resetCalls(); move.mock.resetCalls(); refresh.mock.resetCalls(); error.mock.resetCalls()
  read.mock.mockImplementation(lost); move.mock.mockImplementation(lost)
  root = (await import('react-dom/client')).createRoot(document.body)
})
afterEach(async () => { await act(async () => root.unmount()) })
after(() => window.happyDOM.close())
async function mount(blocked = false) {
  const blocks = new Map<string, TaskBlock>(blocked ? [[task.id, { reason: 'run' }]] : [])
  function Board() {
    saves = useSaves({ issues: [task], blocks, newestRuns: new Map([[task.id, 'run-1']]), onUpdated: refresh, onBusyChange() {} })
    return <p role="status">{saves.message}</p>
  }
  await act(async () => root.render(<Board />))
}
async function drop(to: string) {
  let accepted = false
  await act(async () => { accepted = await saves.moveTo(task.id, to) })
  return accepted
}
function readBack(patch: object) { read.mock.mockImplementation(async () => ({ issue: { ...task, revision: 7, ...patch } })) }

test('a dropped reply reads back one committed status without a second write or a rollback announcement', async () => {
  readBack({ status: 'todo' })
  await mount()
  assert.equal(await drop('todo'), true)
  assert.deepEqual(read.mock.calls.map(call => call.arguments), [[task.id]])
  assert.equal(move.mock.callCount(), 1); assert.equal(refresh.mock.callCount(), 1)
  assert.equal(saves.columns.todo[0].revision, 7); assert.equal(saves.columns.doing.length, 0)
  assert.equal(document.body.textContent, 'changeVerified'); assert.equal(error.mock.callCount(), 0)
})

for (const [name, readback] of Object.entries({
  'write never reached the server': { revision: 6 },
  'different task is returned': { id: 'other', status: 'todo' },
  'concurrent edit replaced the target': { revision: 8, status: 'done' },
  'read also lost its connection': null,
})) test(`lost reply, ${name}: refrain from confirming the change or claiming a rollback`, async () => {
  if (readback) readBack(readback)
  await mount()
  assert.equal(await drop('todo'), false)
  assert.equal(move.mock.callCount(), 1); assert.equal(refresh.mock.callCount(), 1)
  assert.equal(error.mock.calls[0].arguments[0], 'saveUnconfirmed'); assert.equal(document.body.textContent, 'saveUnconfirmed')
})

test('leaving Blocked requires both the status and the cleared block for this run', async () => {
  readBack({ status: 'todo', metadata: { block: { blocked: false, runId: 'older-run' } } })
  await mount(true)
  assert.equal(await drop('todo'), false)
  readBack({ status: 'todo', metadata: { block: { blocked: false, runId: 'run-1' } } })
  assert.equal(await drop('todo'), true)
  assert.equal(read.mock.callCount(), 2)
})

test('an explicit server rejection retains its error and does not request a recovery read', async () => {
  move.mock.mockImplementation(async () => ({ error: 'Denied by server.' }))
  await mount()
  assert.equal(await drop('todo'), false)
  assert.equal(read.mock.callCount(), 0); assert.equal(refresh.mock.callCount(), 1)
  assert.equal(error.mock.calls[0].arguments[0], 'Denied by server.')
})

for (const [status, code, message] of [
  [401, 'desktop_session_expired', 'authRequired'],
  [403, 'desktop_rpc_request_rejected', 'issueAccessLost'],
  [409, 'issueStale', 'issueOutdated'],
  [409, 'desktop_session_changed', 'desktop_session_changed.default'],
] as const) {
  test(`a ${status} ${code} refusal cannot be turned into success by another writer`, async () => {
    move.mock.mockImplementation(async () => { throw Object.assign(new Error(code), { status, code }) })
    readBack({ status: 'todo' })
    await mount()
    assert.equal(await drop('todo'), false)
    assert.equal(read.mock.callCount(), 0)
    assert.equal(error.mock.calls[0].arguments[0], message)
  })
}

test('the readback preserves a newly inaccessible task error', async () => {
  read.mock.mockImplementation(async () => ({ error: 'issueNotFound' }))
  await mount()
  assert.equal(await drop('todo'), false)
  assert.equal(error.mock.calls[0].arguments[0], 'issueNotFound')
})
