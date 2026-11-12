import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
import { SWRConfig } from 'swr'

const win = new Window({ url: 'https://project.example/mikka' })
const stub = (file, namedExports) => mock.module(new URL('../' + file, import.meta.url).href, { namedExports })
const element = tag => ({ children, ...props }) => createElement(tag, props, children)
const writers = []
let impact, reply
const record = (kind, input) => { writers.push([kind, input]); return reply }
stub('app/actions/projects.ts', {
  getProjectLifecycleImpact: async () => impact,
  archiveProject: input => record('archive', input),
  restoreProject: input => record('restore', input),
  deleteProject: input => record('delete', input),
})
mock.module('next-intl', { namedExports: { useTranslations: () => key => key } })
stub('components/ui/dialog.tsx', {
  Dialog: ({ open, children }) => open ? children : null, DialogContent: ({ children }) => children,
  DialogHeader: element('header'), DialogFooter: element('footer'), DialogTitle: element('h2'), DialogDescription: element('p'),
})
stub('components/ui/button.tsx', { Button: ({ variant: _variant, size: _size, ...props }) => createElement('button', props) })
stub('components/ui/input.tsx', { Input: element('input') })

let createRoot, Controls
before(async () => {
  for (const key of ['window','document','HTMLElement','HTMLInputElement','Event','Node']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? win : win[key] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ProjectLifecycleControls: Controls } = await import('../components/workspace/project-lifecycle-controls.tsx'))
})
after(() => win.happyDOM.abort())

async function fixture({ admin = true, canSteer = true, archived = false, deletable = false, revision = 4 } = {}) {
  const project = { id: 'stable', workspaceId: 'workspace', name: 'Retention', revision: 4, canEditProperties: canSteer, archivedAt: archived ? '2026-11-01' : null }
  impact = { projectId: project.id, workspaceId: project.workspaceId, name: project.name, revision, archivedAt: project.archivedAt, counts: { tasks: deletable ? 0 : 2 }, canDelete: deletable }
  writers.length = 0
  let updated = 0, deleted = 0
  const host = document.body.appendChild(document.createElement('main'))
  const root = createRoot(host)
  const button = name => [...host.querySelectorAll('button')].find(node => node.textContent === name)
  const click = async name => { const node = button(name); assert.ok(node, 'missing button ' + name); await act(async () => node.click()) }
  await act(async () => root.render(createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } },
    createElement(Controls, { readerId: 'owner', project, admin, beforeOpen: async () => true,
      onUpdated: () => { updated++ }, onDeleted: () => { deleted++ } }))))
  await click(canSteer ? 'actions' : 'impact')
  return { host, button, click, updated: () => updated, deleted: () => deleted,
    close: async () => { await act(async () => root.unmount()); host.remove() } }
}

test('authorized archive and restore dispatch the matching current receipt, keep delivery status separate and recover from refusal', async () => {
  const expected = { id: 'stable', workspaceId: 'workspace', revision: 4 }
  for (const [archived, operation] of [[false,'archive'],[true,'restore']]) {
    const f = await fixture({archived})
    try {
      assert.equal(f.button('delete'), undefined)
      assert.equal(f.button(archived ? 'archive' : 'restore'), undefined)
      reply = { error: 'Access changed' }
      await f.click(operation)
      assert.equal(f.host.querySelector('[role="alert"]').textContent, 'Access changed')
      reply = { project: { id: 'stable', archivedAt: archived ? null : '2026-11-12' } }
      await f.click(operation)
      assert.deepEqual(writers, [[operation,expected],[operation,expected]])
      assert.equal(f.button(operation), undefined)
      assert.equal(f.deleted(), 0)
    } finally { await f.close() }
  }
})

test('read-only viewers can inspect impact; a stale receipt offers retry without writers; only admins can confirm strict deletion', async () => {
  for (const setup of [{canSteer:false,deletable:true},{revision:3},{admin:false,deletable:true}]) {
    const f = await fixture(setup)
    try {
      assert.equal(f.button('delete'), undefined)
      if (setup.canSteer === false || setup.revision !== undefined) assert.equal(f.button('archive'), undefined)
      if (setup.revision) assert.ok(f.button('retry'))
      assert.equal(writers.length, 0)
    } finally { await f.close() }
  }
  const f = await fixture({deletable:true})
  try {
    await f.click('delete')
    assert.ok(f.button('delete').disabled)
    const field = f.host.querySelector('input')
    const value = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
    await act(async () => { value.call(field,'wrong'); field.dispatchEvent(new win.Event('input',{bubbles:true})) })
    assert.ok(f.button('delete').disabled)
    await act(async () => { value.call(field,'Retention'); field.dispatchEvent(new win.Event('input',{bubbles:true})) })
    assert.equal(f.button('delete').disabled,false)
    reply = { deleted: true, projectId: 'stable' }
    await f.click('delete')
    assert.deepEqual(writers,[['delete',{id:'stable',workspaceId:'workspace',revision:4,confirmation:'Retention'}]])
    assert.equal(f.deleted(),1)
  } finally { await f.close() }
})
