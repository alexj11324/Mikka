import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { ViewStateProvider } from '../lib/hooks/view-state'
import { clearChatDrafts } from '../lib/chat-drafts'
import type { ThreadRecord } from '../components/blocks/rich-text-editor-4/components/rich-text-comments'

// Real DOM: invalid stored content must render read-only (no autosave/sync label, no typing hint, not editable).
const invalid = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mystery', text: 'kept' }] }] }
const translate = (key: string) => key
const u = (path: string) => new URL(path, import.meta.url).href
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useLocale: () => 'zh-CN', useFormatter: () => ({ dateTime: () => '08:00' }) } })
mock.module(u('../app/actions/issues.ts'), { namedExports: {
  pollIssue: async (id: string) => ({ viewerId: 'u1', version: 'a'.repeat(32), issue: { id, title: 'Invalid body', content: invalid, status: 'todo', priority: 'normal', identifier: 'MIK-1', userId: 'u1', updatedAt: new Date(), createdAt: new Date() } }),
  pollIssueVersionSummaries: async () => ({ viewerId: 'u1', snapshot: { version: 'a'.repeat(32), items: [], positions: [] } }),
  saveIssue: async () => { throw new Error('read-only must not save') },
  listIssueVersions: async () => [],
} })
mock.module(u('../app/actions/issue-operations.ts'), { namedExports: { getDeletedIssue: async () => null, listIssueConnections: async () => [], setIssueDeleted: async () => {} } })
mock.module(u('../lib/document-sync.ts'), { namedExports: { DocumentSync: class { constructor() { throw new Error('read-only must not construct DocumentSync') } } } })
const stub = (name: string) => () => <div data-stub={name} />
for (const [file, names] of [
  ['issue-description-history', ['IssueDescriptionHistory']], ['issue-relations', ['IssueRelations']],
  ['issue-members', ['IssueMembers']],
  ['issue-thread-panel', ['IssueThreadPanel']], ['factory-acceptance', ['FactoryAcceptance', 'FactoryAcceptancePanel']], ['issue-activity-feed', ['IssueActivityFeed']],
] as const) mock.module(u(`../components/workspace/${file}.tsx`), { namedExports: Object.fromEntries(names.map(name => [name, stub(name)])) })
mock.module(u('../components/workspace/issue-threads.tsx'), { namedExports: { IssueThreads: stub('IssueThreads'), useAgentActivity: () => ({ rows: [], error: null }) } })
mock.module(u('../components/workspace/task-detail-frame.tsx'), { namedExports: {
  FramedTask: (props: import('../components/workspace/task-detail-frame').FramedTaskProps) =>
    <><header data-save-label={props.saveLabel} />{props.editor(null, discussions =>
      <textarea id="issue-comment" disabled={discussions.readOnly} />)}</>,
} })

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
before(async () => {
  for (const key of ['window', 'document', 'sessionStorage', 'navigator', 'HTMLElement', 'Node', 'Element', 'getComputedStyle', 'MutationObserver', 'DOMParser', 'Range', 'Selection', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver', 'DocumentFragment', 'Text', 'KeyboardEvent', 'MouseEvent', 'ClipboardEvent', 'DragEvent', 'InputEvent', 'FocusEvent', 'Event'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})

async function render(node: ReactNode, ready = '.ProseMirror') {
  const container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  for (let i = 0; i < 300 && !container.querySelector(ready); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  return { container, update: (next: ReactNode) => act(async () => { root.render(next) }), done: () => act(async () => { root.unmount(); container.remove() }) }
}

test('legacy machine instructions can be opened without hiding related work or rewriting the task', async () => {
  const { IssueEditor } = await import('../components/workspace/issue-editor')
  const digest = 'ac'.repeat(32)
  const raw = ['Implement the file contract.', ...Array.from({ length: 20 }, (_, i) => `src/module-${i}.ts sha256: ${digest}`)].join('\n')
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] }
  const { container, done } = await render(<IssueEditor issueId="legacy-instructions" layout="issue" content={content}
    onChange={() => { throw new Error('opening instructions cannot edit the task') }} afterDescription={<a href="#linked-work">Related conversation</a>} />)
  try {
    const disclosure = container.querySelector('[data-slot="collapsible"]')
    assert.ok(disclosure)
    const summary = disclosure.querySelector<HTMLButtonElement>('button[data-slot="collapsible-trigger"]')
    assert.equal(summary?.getAttribute('aria-expanded'), 'false')
    assert.ok(summary?.textContent)
    assert.ok(!disclosure.contains(container.querySelector('a[href="#linked-work"]')))
    await act(async () => { summary.click() })
    assert.equal(summary.getAttribute('aria-expanded'), 'true')
    assert.equal(disclosure.querySelector('.ProseMirror')?.getAttribute('contenteditable'), 'true')
    assert.equal(disclosure.querySelector('.ProseMirror')?.textContent, raw)
  } finally { await done() }
})

test('a long human task brief stays visible', async () => {
  const { IssueEditor } = await import('../components/workspace/issue-editor')
  const text = 'Talk to the customer and record the outcome. '.repeat(35)
  const { container, done } = await render(<IssueEditor layout="issue" content={{ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
  ] }} onChange={() => {}} />)
  try {
    assert.equal(container.querySelector('[data-slot="collapsible"]'), null)
    assert.equal(container.querySelector('.ProseMirror')?.textContent, text)
  } finally { await done() }
})

test('IssueEditor: unreadable content is not editable and shows no typing hint or sync label', async () => {
  const { IssueEditor } = await import('../components/workspace/issue-editor')
  const { container, done } = await render(<IssueEditor issueId="issue-readonly" content={invalid} onChange={() => { throw new Error('no echo') }} layout="issue" syncLabel="" />)
  const prose = container.querySelector('.ProseMirror')
  assert.ok(prose, 'editor mounted')
  assert.equal(prose.getAttribute('contenteditable'), 'false')
  assert.equal(container.querySelectorAll('[data-placeholder]').length, 0)
  assert.equal(container.querySelector<HTMLTextAreaElement>('#issue-comment')?.disabled, true, 'the timeline remains visible without accepting unsaved comments')
  await done()
})

test('TaskDetail: invalid content opens read-only, with an empty save label and a disabled editor', async () => {
  const { TaskDetail } = await import('../components/workspace/task-detail')
  const noop = () => {}
  const { container, done } = await render(<TaskDetail id="issue-1" thread={null} origin="看板" user={{ id: 'u1', name: 'U', email: 'u@example.invalid' }} navigation={{ index: -1, total: 0, previous: null, next: null } as never}
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
  assert.equal(container.querySelector<HTMLTextAreaElement>('#issue-comment')?.disabled, true, 'verified malformed content has no writable discussion document')
  await done()
})

test('read-only editor extensions carry no Placeholder; editable ones do', async () => {
  const { createEditorExtensions } = await import('../components/workspace/issue-editor-schema')
  const names = (placeholder: string | null) => createEditorExtensions(() => false, 'a', false, false, placeholder).map(extension => extension.name)
  assert.ok(!names(null).includes('placeholder'))
  assert.ok(names('hint').includes('placeholder'))
})

const activityThreads: ThreadRecord[] = ['discussion-a', 'discussion-b'].map(id => ({
  id, author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
  messages: [{ id: `${id}-message`, author: 'Owner', body: 'Existing comment', at: '2026-11-07T08:00:00Z' }],
}))

async function activityFixture() {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  browser.sessionStorage.clear()
  const comments: string[] = [], replies: { id: string; body: string }[] = []
  const view = ({ shown = true, issueId = 'issue-a', scope = 'owner:workspace-a' } = {}) =>
    <ViewStateProvider scope={scope}>{shown && <IssueActivity issueId={issueId} author="Owner" threads={activityThreads} anchors={[]}
      onComment={body => { comments.push(body) }} onReply={(id, body) => { replies.push({ id, body }) }} onResolve={() => {}} onSelect={() => {}} />}</ViewStateProvider>
  const { container, update, done } = await render(view(), '#issue-comment')
  const field = (selector: string) => {
    const element = container.querySelector<HTMLTextAreaElement>(selector)
    assert.ok(element, `mounted field ${selector}`)
    return element
  }
  const type = (selector: string, value: string) => act(async () => {
    const element = field(selector)
    element.focus()
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
  const submit = (selector: string) => act(async () => {
    field(selector).closest('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
  })
  return { container, field, type, submit, comments, replies, done, show: (options?: Parameters<typeof view>[0]) => update(view(options)), remove: () => update(null) }
}

test('IssueActivity: closing a task and reopening restores the comment and its reply target without submitting', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', 'Keep this task comment while data refreshes')
    await fixture.type('#reply-discussion-b', 'Reply after checking another task')
    await fixture.show({ shown: false })
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, 'Keep this task comment while data refreshes')
    assert.equal(fixture.field('#reply-discussion-b').value, 'Reply after checking another task')
    assert.equal(fixture.field('#reply-discussion-a').value, '')
    assert.equal(fixture.container.querySelector<HTMLButtonElement>('[aria-label="sendComment"]')?.disabled, false)
    assert.deepEqual(fixture.comments, [])
    assert.deepEqual(fixture.replies, [])
  } finally { await fixture.done() }
})

test('IssueActivity: changing the task immediately switches both drafts and restores each task independently', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', 'Task A comment')
    await fixture.type('#reply-discussion-a', 'Task A reply')
    await fixture.show({ issueId: 'issue-b' })
    assert.equal(fixture.field('#issue-comment').value, '')
    assert.equal(fixture.field('#reply-discussion-a').value, '')
    await fixture.type('#issue-comment', 'Task B comment')
    await fixture.type('#reply-discussion-b', 'Task B reply')
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, 'Task A comment')
    assert.equal(fixture.field('#reply-discussion-a').value, 'Task A reply')
    assert.equal(fixture.field('#reply-discussion-b').value, '')
    await fixture.show({ issueId: 'issue-b' })
    assert.equal(fixture.field('#issue-comment').value, 'Task B comment')
    assert.equal(fixture.field('#reply-discussion-b').value, 'Task B reply')
  } finally { await fixture.done() }
})

test('IssueActivity: changing the account or workspace hides the previous scope drafts', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', 'Private comment draft')
    await fixture.type('#reply-discussion-b', 'Private reply draft')
    for (const scope of ['owner:workspace-b', 'other-owner:workspace-a']) {
      await fixture.show({ scope })
      assert.equal(fixture.field('#issue-comment').value, '')
      assert.equal(fixture.field('#reply-discussion-b').value, '')
    }
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, 'Private comment draft')
    assert.equal(fixture.field('#reply-discussion-b').value, 'Private reply draft')
  } finally { await fixture.done() }
})

test('IssueActivity: the real logout helper erases comment and reply drafts before a later login', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', 'Private comment draft')
    await fixture.type('#reply-discussion-b', 'Private reply draft')
    clearChatDrafts()
    await fixture.remove()
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, '')
    assert.equal(fixture.field('#reply-discussion-b').value, '')
    await fixture.type('#issue-comment', 'Fresh session comment')
    await fixture.show({ shown: false })
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, 'Fresh session comment')
  } finally { await fixture.done() }
})

test('IssueActivity: submitting clears only the sent draft and navigation never replays a comment or reply', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', '  Accepted comment  ')
    await fixture.type('#reply-discussion-b', '  Accepted reply  ')
    await fixture.submit('#issue-comment')
    assert.deepEqual(fixture.comments, ['Accepted comment'])
    assert.equal(fixture.field('#reply-discussion-b').value, '  Accepted reply  ')
    await fixture.submit('#reply-discussion-b')
    assert.deepEqual(fixture.replies, [{ id: 'discussion-b', body: 'Accepted reply' }])
    await fixture.show({ shown: false })
    await fixture.show()
    assert.equal(fixture.field('#issue-comment').value, '')
    assert.equal(fixture.field('#reply-discussion-b').value, '')
    assert.deepEqual(fixture.comments, ['Accepted comment'])
    assert.deepEqual(fixture.replies, [{ id: 'discussion-b', body: 'Accepted reply' }])
  } finally { await fixture.done() }
})

test('IssueEditor: a cached preview does not restore activity drafts before receiving the verified task id', async () => {
  const fixture = await activityFixture()
  try {
    await fixture.type('#issue-comment', 'Only restore after task access is confirmed')
    await fixture.remove()
    const { IssueEditor } = await import('../components/workspace/issue-editor')
    const view = (issueId?: string) => <ViewStateProvider scope="owner:workspace-a"><IssueEditor issueId={issueId} content={invalid} onChange={() => {}} layout="issue" disabled /></ViewStateProvider>
    const editor = await render(view())
    try {
      assert.equal(editor.container.querySelector('#issue-comment'), null)
      await editor.update(view('issue-a'))
      const draft = editor.container.querySelector<HTMLTextAreaElement>('#issue-comment')
      assert.ok(draft)
      assert.equal(draft.value, 'Only restore after task access is confirmed')
      assert.equal(draft.disabled, true)
      const form = draft.closest('form')!
      await act(async () => { form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) })
      assert.equal(draft.value, 'Only restore after task access is confirmed', 'a rejected write cannot clear the stored draft')
    } finally { await editor.done() }
  } finally { await fixture.done() }
})
