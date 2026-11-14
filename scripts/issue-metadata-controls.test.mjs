import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { metadataSchema } from '../lib/issue-metadata.ts'

const browser = new Window({ url: 'https://mikka.example/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? browser : browser[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
after(() => browser.close())

let latest, readResult, writes, changes
const translate = Object.assign(key => key, { has: () => true })
const stub = (path, namedExports) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
const children = ({ children }) => children
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module('swr', { defaultExport: () => ({}) })
stub('app/actions/issues.ts', { pollIssue: async () => readResult ?? { issue: latest } })
stub('app/actions/projects.ts', { moveIssueToProject: () => {} })
stub('app/actions/issue-metadata.ts', { getIssuePropertyOptions: () => ({}), updateIssueMetadata: async input => {
  writes.push(input)
  return input.revision === latest.revision ? { issue: { ...latest, revision: latest.revision + 1 } } : { error: 'issueOutdated' }
} })
stub('components/workspace/issue-assignee-menu.tsx', { IssueAssigneeMenu: () => null })
stub('components/workspace/issue-pull-request-link.tsx', { IssuePullRequestLink: () => null })
stub('components/ui/dialog.tsx', { Dialog: ({ open, children }) => open ? children : null, DialogContent: children, DialogDescription: children, DialogFooter: children, DialogHeader: children, DialogTitle: children })
stub('components/ui/alert-dialog.tsx', Object.fromEntries(['AlertDialog', 'AlertDialogAction', 'AlertDialogCancel', 'AlertDialogContent', 'AlertDialogDescription', 'AlertDialogFooter', 'AlertDialogHeader', 'AlertDialogTitle'].map(key => [key, () => null])))
const { createRoot } = await import('react-dom/client')
const { IssueMetadataControls } = await import('../components/workspace/issue-metadata-controls.tsx')
const issue = (revision, labels) => ({ id: 'issue', revision, metadata: metadataSchema.parse({ labels }) })
const red = name => ({ name, color: 'red' })

test('an open label form pins its revision, retains its draft across a failed read, and rebases only for an explicit retry', async () => {
  const base = issue(1, [red('Removed elsewhere')])
  latest = issue(2, [red('Added elsewhere')]); writes = []; changes = []
  const request = { target: 'labels', sequence: 1 }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = task => act(async () => root.render(createElement(IssueMetadataControls, { section: 'dialog', task, request, onSaved: (row, source) => changes.push([row.revision, source]) })))
  const submit = () => act(async () => host.querySelector('form').dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })))
  try {
    await render(base)
    const field = host.querySelector('input:not([type=checkbox])')
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value').set.call(field, 'My draft')
      field.dispatchEvent(new browser.Event('input', { bubbles: true }))
    })
    await render(latest)
    readResult = { error: 'issueUnavailable' }
    await submit()
    assert.match(host.textContent, /issueUnavailable/)
    assert.deepEqual(changes, [])
    readResult = null
    await submit()
    assert.deepEqual(writes.map(write => write.revision), [1, 1])
    assert.deepEqual(changes, [[2, 'refresh']])
    assert.match(host.textContent, /issueStale/)
    assert.equal(field.value, 'My draft')
    assert.ok(host.textContent.includes('Added elsewhere'))
    assert.ok(!host.textContent.includes('Removed elsewhere'))
    await submit()
    assert.equal(writes.length, 3)
    assert.equal(writes[2].revision, 2)
    assert.deepEqual(writes[2].patch.labels, [red('Added elsewhere'), { name: 'My draft', color: 'violet' }])
    assert.deepEqual(changes, [[2, 'refresh'], [3, 'save']])
    assert.equal(host.querySelector('form'), null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
