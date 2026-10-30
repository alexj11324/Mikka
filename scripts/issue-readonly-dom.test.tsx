import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'

// Real DOM: invalid stored content must render read-only (no autosave/sync label, no typing hint, not editable).
const invalid = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mystery', text: 'kept' }] }] }
const translate = (key: string) => key
const u = (path: string) => new URL(path, import.meta.url).href
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useLocale: () => 'zh-CN', useFormatter: () => ({}) } })
mock.module(u('../app/actions/issues.ts'), { namedExports: {
  getIssue: async (id: string) => ({ id, title: 'Invalid body', content: invalid, status: 'todo', priority: 'normal', identifier: 'MIK-1', userId: 'u1', updatedAt: new Date(), createdAt: new Date() }),
  saveIssue: async () => { throw new Error('read-only must not save') },
  listIssueVersions: async () => [],
} })
mock.module(u('../app/actions/issue-operations.ts'), { namedExports: { getDeletedIssue: async () => null, listIssueConnections: async () => [], setIssueDeleted: async () => {} } })
mock.module(u('../lib/document-sync.ts'), { namedExports: { DocumentSync: class { constructor() { throw new Error('read-only must not construct DocumentSync') } } } })
const stub = (name: string) => () => <div data-stub={name} />
for (const [file, names] of [
  ['issue-detail-actions', ['IssueDetailActions']], ['issue-description-history', ['IssueDescriptionHistory']], ['issue-relations', ['IssueRelations']],
  ['issue-members', ['IssueMembers']], ['issue-detail-properties', ['IssueDetailProperties']], ['issue-threads', ['IssueThreads', 'ThreadEvents']],
  ['issue-thread-panel', ['IssueThreadPanel']], ['factory-acceptance', ['FactoryAcceptance']], ['issue-activity-feed', ['IssueActivityFeed']],
] as const) mock.module(u(`../components/workspace/${file}.tsx`), { namedExports: Object.fromEntries(names.map(name => [name, stub(name)])) })
mock.module(u('../components/workspace/issue-detail-header.tsx'), { namedExports: { IssueDetailHeader: ({ saveLabel }: { saveLabel: string }) => <header data-save-label={saveLabel}>{saveLabel}</header> } })

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'getComputedStyle', 'MutationObserver', 'DOMParser', 'Range', 'Selection', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver', 'DocumentFragment', 'Text', 'KeyboardEvent', 'MouseEvent', 'ClipboardEvent', 'DragEvent', 'InputEvent', 'FocusEvent', 'Event'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})

async function render(node: ReactNode, ready = '.ProseMirror') {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  for (let i = 0; i < 300 && !container.querySelector(ready); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  return { container, done: () => act(async () => { root.unmount() }) }
}

test('IssueEditor: unreadable content is not editable and shows no typing hint or sync label', async () => {
  const { IssueEditor } = await import('../components/workspace/issue-editor')
  const { container, done } = await render(<IssueEditor content={invalid} onChange={() => { throw new Error('no echo') }} layout="issue" syncLabel="" />)
  const prose = container.querySelector('.ProseMirror')
  assert.ok(prose, 'editor mounted')
  assert.equal(prose.getAttribute('contenteditable'), 'false')
  assert.equal(container.querySelectorAll('[data-placeholder]').length, 0)
  await done()
})

test('TaskDetail: invalid content opens read-only, with an empty save label and a disabled editor', async () => {
  const { TaskDetail } = await import('../components/workspace/task-detail')
  const noop = () => {}
  const { container, done } = await render(<TaskDetail id="issue-1" workspaceName="W" user={{ id: 'u1', name: 'U', email: 'u@example.invalid' }} navigation={{ index: -1, total: 0, previous: null, next: null } as never}
    onOpen={noop} onSaved={noop} onDirty={noop} onClose={noop} onDeleted={noop} onRegisterFlush={noop} />, '[data-save-label] ~ * .ProseMirror, .ProseMirror')
  const header = container.querySelector('[data-save-label]')
  assert.ok(header, 'header rendered')
  assert.equal(header.getAttribute('data-save-label'), '')
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1)
  const prose = container.querySelector('.ProseMirror')
  assert.ok(prose, 'editor mounted')
  assert.equal(prose.getAttribute('contenteditable'), 'false')
  assert.equal(container.querySelectorAll('[data-placeholder]').length, 0)
  assert.doesNotMatch(container.textContent ?? '', /syncFailedLabel|syncedLabel|autosaved/)
  await done()
})

test('read-only editor extensions carry no Placeholder; editable ones do', async () => {
  const { createEditorExtensions } = await import('../components/workspace/issue-editor-schema')
  const names = (placeholder: string | null) => createEditorExtensions(() => false, 'a', false, false, placeholder).map(extension => extension.name)
  assert.ok(!names(null).includes('placeholder'))
  assert.ok(names('hint').includes('placeholder'))
})
