import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const window = new Window({ url: 'http://localhost/mikka/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let write, cache, reads, notices
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: {
  setIssueScope: input => write(input),
} })
mock.module('swr', { defaultExport: (key, fetcher) => { reads.push({ key, fetcher }); return { data: cache } } })
mock.module('next-intl', { namedExports: { useTranslations: () => key => key } })
mock.module('sonner', { namedExports: { toast: { error: message => notices.push(['error', message]), success: message => notices.push(['success', message]) } } })
mock.module(new URL('../lib/use-action-error.ts', import.meta.url).href, { namedExports: { useActionError: () => code => code } })
const { useTaskOwnershipRows } = await import('../components/workspace/issue-scope-control.tsx')
const task = {
  id: 'task-a', userId: 'owner', workspaceId: 'alpha', ownershipState: 'bound', scope: 'personal',
  revision: 3, linearSyncPolicy: 'disabled', linearSyncBlocked: true, linearTargetVerified: false,
}
const synced = { ...task, linearSyncPolicy: 'explicit', linearSyncBlocked: false, linearTargetVerified: true }
const settle = () => new Promise(resolve => setImmediate(resolve))

async function mount(overrides = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const saves = []
  let rows
  let props = { task, viewerId: 'owner', preview: false, locked: false, ...overrides }
  function Frame() {
    rows = useTaskOwnershipRows(props.task, props.viewerId, props.preview, props.locked, issue => saves.push(issue))
    return null
  }
  async function render(next = {}) {
    props = { ...props, ...next }
    await act(async () => root.render(createElement(Frame)))
  }
  await render()
  return { render, rows: () => rows, saves, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
test.beforeEach(() => {
  cache = { accounts: [{ id: 'owner', choices: [{ id: 'alpha', name: 'Engineering' }] }] }
  reads = []; notices = []
  write = () => { throw Error('unexpected write') }
})

test('the Task workspace is a fixed authorized binding, independent of the old scope and the selected workspace', async () => {
  const view = await mount()
  try {
    const row = () => view.rows().find(item => item.id === 'workspace')
    assert.equal(row().value.text, 'Engineering')
    assert.equal(row().menu, undefined)
    assert.equal(row().onClick, undefined)
    assert.deepEqual(view.rows().map(item => item.id), ['workspace'])
    cache = { accounts: [{ id: 'peer', choices: [{ id: 'alpha', name: 'Another session' }] }] }
    await view.render({ task: { ...task, scope: 'workspace' } })
    assert.equal(row().value.text, 'alpha')
    await view.render({ preview: true })
    assert.equal(row().value.text, 'workspaceUnavailable')
    await view.render({ preview: false, task: { ...task, ownershipState: 'pending' } })
    assert.equal(row().value.text, 'workspaceUnavailable')
    assert.ok(reads.every(call => call.fetcher === null))
    assert.deepEqual(notices, [])
  } finally { await view.unmount() }
})

test('only the signed-in owner of an explicitly syncing Task can turn off Linear and save the returned policy', async () => {
  const calls = []
  let finish
  write = input => { calls.push(input); return new Promise(resolve => { finish = resolve }) }
  const view = await mount({ task: synced, viewerId: 'member' })
  try {
    const row = () => view.rows().find(item => item.id === 'linearSync')
    assert.equal(row().menu, undefined)
    await view.render({ viewerId: 'owner', locked: true })
    assert.equal(row().menu, undefined)
    await view.render({ locked: false })
    const disable = row().menu[0]
    assert.equal(disable.label, 'disableLinkedLinear')
    await act(async () => { disable.onSelect(); disable.onSelect(); await settle() })
    assert.deepEqual(calls, [{ id: task.id, revision: 3, scope: 'personal' }])
    const result = { ...task, scope: 'workspace', revision: 4 }
    await act(async () => { finish({ issue: result }); await settle() })
    assert.deepEqual(view.saves, [result])
    assert.deepEqual(notices, [['success', 'linearDisabled']])
    await view.render({ task: result })
    assert.equal(row(), undefined)
  } finally { await view.unmount() }
})

test('failed and superseded Linear writes never report a changed workspace or false success', async () => {
  let finish
  write = () => new Promise(resolve => { finish = resolve })
  const view = await mount({ task: { ...synced, linearTargetVerified: false } })
  try {
    const action = () => view.rows().find(row => row.id === 'linearSync').menu[0]
    assert.equal(action().label, 'disableLinear')
    await act(async () => { action().onSelect(); await settle(); finish({ error: 'issueStale' }); await settle() })
    assert.deepEqual(notices, [['error', 'issueStale']])
    await act(async () => { action().onSelect(); await settle() })
    await view.render({ task: { ...task, id: 'task-b' } })
    await act(async () => { finish({ issue: { ...task, revision: 4 } }); await settle() })
    assert.deepEqual(view.saves, [])
    assert.deepEqual(notices, [['error', 'issueStale']])
  } finally { await view.unmount() }
})
