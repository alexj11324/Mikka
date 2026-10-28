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
let readTeam, promote, saves, notices
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: {
  promoteIssueToTeam: input => promote(input), setIssueScope: () => { throw Error('legacy action forbidden') },
} })
mock.module(new URL('../app/actions/team-relations.ts', import.meta.url).href, { namedExports: { getIssueTeam: () => readTeam() } })
mock.module('next-intl', { namedExports: { useTranslations: () => key => key } })
mock.module('sonner', { namedExports: { toast: { error: value => notices.push(value), success: value => notices.push(value) } } })
mock.module(new URL('../lib/use-action-error.ts', import.meta.url).href, { namedExports: { useActionError: () => code => code } })
// Only the menu primitive and transport are substituted. Real component hooks,
// layout effects, event handler, intent helper and lifecycle execute unchanged.
mock.module(new URL('../components/workspace/issue-property-menu.tsx', import.meta.url).href, { namedExports: {
  IssuePropertyMenu: props => createElement('button', { onClick: () => props.onChange('workspace') }, 'share'),
} })
const { IssueScopeControl } = await import('../components/workspace/issue-scope-control.tsx')
const task = { id: 'task-a', revision: 3, scope: 'personal', scopeSetBy: 'user' }
const teamChoice = { issueId: task.id, teamId: 'team-a', selectionId: 'save-a' }
const settle = () => new Promise(resolve => setImmediate(resolve))

async function mount(overrides = {}) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  let mounted = true
  const props = { task, teamChoice, onSaved: issue => saves.push(issue), ...overrides }
  const render = async next => { await act(async () => root.render(createElement(IssueScopeControl, { ...props, ...next }))) }
  await render({})
  return { host, render,
    click: () => act(async () => { host.querySelector('button').click(); await settle() }),
    unmount: async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); host.remove() } },
  }
}

test('actual scope component cancels the waiting read on selection/task/revision changes and unmount', async () => {
  for (const change of ['clear', 'selection', 'task', 'revision', 'unmount']) {
    let release, calls = 0
    const relation = new Promise(resolve => { release = resolve })
    readTeam = () => relation; promote = async () => { calls++; return { issue: task } }; saves = []; notices = []
    const view = await mount()
    try {
      await view.click()
      if (change === 'unmount') await view.unmount()
      else await view.render(change === 'clear' ? { teamChoice: null }
        : change === 'selection' ? { teamChoice: { ...teamChoice, selectionId: 'save-b', teamId: 'team-b' } }
          : { task: { ...task, ...(change === 'task' ? { id: 'task-b' } : { revision: 4 }) } })
      await act(async () => { release('team-a'); await settle() })
      assert.deepEqual({ calls, saves, notices }, { calls: 0, saves: [], notices: [] }, change)
    } finally { await view.unmount() }
  }
})

test('actual scope component refuses persisted team without this human choice and submits an explicit choice', async () => {
  let reads = 0, calls = []
  readTeam = async () => { reads++; return 'team-a' }; promote = async input => { calls.push(input); return { issue: { ...task, scope: 'workspace' } } }; saves = []; notices = []
  const missing = await mount({ teamChoice: null })
  try { await missing.click(); assert.equal(reads, 0); assert.equal(calls.length, 0); assert.equal(saves.length, 0) }
  finally { await missing.unmount() }
  notices = []
  const chosen = await mount()
  try {
    await chosen.click()
    assert.equal(calls.length, 1)
    assert.deepEqual({ ...calls[0], requestId: 'checked' }, { requestId: 'checked', issueId: task.id, revision: 3, teamId: 'team-a', expectedTeamId: 'team-a' })
    assert.match(calls[0].requestId, /^[0-9a-f-]{36}$/)
    assert.equal(saves.length, 1)
  } finally { await chosen.unmount() }
})
