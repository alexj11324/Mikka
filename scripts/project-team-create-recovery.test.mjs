import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, createElement, Fragment } from 'react'
import { Window } from 'happy-dom'

const page = new Window({ url: 'https://example.invalid/mikka/en' })
const team = 'a432688c-38ce-47d1-b1eb-434ad1957713'
const saved = { id: '720d08f2-1d52-4b51-9fc3-6c1f1c649f55', revision: 1 }
const calls = []
let relation
const empty = () => null
const children = ({ children }) => createElement(Fragment, null, children)
mock.module('../app/actions/projects.ts', { namedExports: {
  saveProject: async () => { calls.push('create'); return { project: saved } },
  updateProjectProperties: () => assert.fail('Unexpected project edit'),
} })
mock.module('../app/actions/teams.ts', { namedExports: { listTeams: async () => [{ id: team, name: 'Design' }] } })
mock.module('../app/actions/team-relations.ts', { namedExports: {
  setProjectTeams: async data => {
    calls.push('attach')
    assert.equal(data.projectId, saved.id)
    assert.deepEqual(data.teamIds, [team])
    if (relation === 'transport') throw new Error('offline')
    return relation === 'denied' ? { ok: false, error: 'denied' } : { ok: true, data: { ...saved, revision: 2 } }
  },
} })
mock.module('next-intl', { namedExports: { useTranslations: () => key => key, useMessages: () => ({}) } })
mock.module('../components/ui/dialog.tsx', { namedExports: {
  Dialog: children, DialogContent: children, DialogHeader: children, DialogTitle: children, DialogDescription: children,
} })
mock.module('../components/workspace/project-property-controls.tsx', { namedExports: { ProjectPicker: empty, ProjectPropertyControl: empty, projectDirectory: () => [] } })
mock.module('../components/workspace/project-milestones.tsx', { namedExports: { ProjectMilestones: empty } })
mock.module('../components/workspace/issue-editor.tsx', { namedExports: { IssueEditor: empty } })
mock.module('sonner', { namedExports: { toast: { warning: () => calls.push('warning') } } })

let createRoot, ProjectForm
before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'Node']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? page : page[key] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ProjectForm } = await import('../components/workspace/project-form.tsx'))
})
after(() => page.happyDOM.abort())

test('project creation reports the team actually attached so the saved project opens in its reachable directory', async () => {
  for (const [chosen, outcome, expectedTeam] of [[team, 'denied', null], [team, 'transport', null], [team, 'saved', team], ['', 'none', null]]) {
    const host = document.body.appendChild(document.createElement('main'))
    const root = createRoot(host)
    relation = outcome
    calls.length = 0
    const received = []
    try {
      await act(async () => root.render(createElement(ProjectForm, {
        directory: { workspaceId: 'workspace', members: [] }, initialTeamId: chosen,
        onClose() {}, onSaved: (...args) => received.push(args),
      })))
      await act(async () => host.querySelector('form').dispatchEvent(new page.Event('submit', { bubbles: true, cancelable: true })))
      assert.deepEqual(calls, chosen ? ['create', 'attach', ...(outcome === 'saved' ? [] : ['warning'])] : ['create'])
      assert.deepEqual(received, [[{ ...saved, revision: outcome === 'saved' ? 2 : 1 }, expectedTeam]])
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  }
})

test('a selected project missing from the current directory retains an explicit Retry and an exit to its own list', async () => {
  const { ProjectWorkspace } = await import('../components/workspace/project-workspace.tsx')
  const { ViewStateProvider } = await import('../lib/hooks/view-state.tsx')
  const host = page.document.createElement('div')
  page.document.body.append(host)
  const root = createRoot(host)
  let retries = 0
  let selected = saved.id
  const render = async (loading = false, error = false) => act(async () => {
    root.render(createElement(ViewStateProvider, { scope: 'test-project' }, createElement(ProjectWorkspace, {
      readerId: 'reader', projects: [], projectId: selected, loading, error, issues: [], team: 'Design', initialTeamId: team,
      onUpdated: () => { retries++ }, onSelect: id => { selected = id },
    })))
  })
  const button = label => [...host.querySelectorAll('button')].find(node => node.textContent === label)
  try {
    await render(true)
    assert.ok(host.querySelector('[role="status"]'))
    await render(false, true)
    assert.match(host.textContent, /Projects.loadErrorTitle/)
    await render()
    assert.match(host.textContent, /Errors.projectNotFound/)
    assert.equal(button('Projects.form.createTitle'), undefined)
    await act(async () => { button('Common.retry').click() })
    assert.equal(retries, 1)
    assert.equal(selected, saved.id)
    await act(async () => { button('Overview.viewProjects').click() })
    assert.equal(selected, null)
    await render()
    assert.doesNotMatch(host.textContent, /Errors.projectNotFound/)
    assert.ok(button('Projects.form.createTitle'))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
