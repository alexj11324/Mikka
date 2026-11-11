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
  ['issue-detail-actions', ['IssueDetailActions']], ['issue-description-history', ['IssueDescriptionHistory']], ['issue-relations', ['IssueRelations']],
  ['issue-members', ['IssueMembers']], ['issue-detail-properties', ['IssueDetailProperties']],
  ['issue-thread-panel', ['IssueThreadPanel']], ['factory-acceptance', ['FactoryAcceptance', 'FactoryAcceptancePanel']], ['issue-activity-feed', ['IssueActivityFeed']],
] as const) mock.module(u(`../components/workspace/${file}.tsx`), { namedExports: Object.fromEntries(names.map(name => [name, stub(name)])) })
mock.module(u('../components/workspace/issue-threads.tsx'), { namedExports: { IssueThreads: stub('IssueThreads'), useAgentActivity: () => ({ rows: [], error: null }) } })
// The layer-drawn page (task-detail slot) is not under test here; its hooks read actions these mocks leave out.
mock.module(u('../components/workspace/task-detail-frame.tsx'), { namedExports: { FramedTask: () => null } })
mock.module(u('../components/workspace/issue-detail-header.tsx'), { namedExports: { IssueDetailHeader: ({ saveLabel }: { saveLabel: string }) => <header data-save-label={saveLabel}>{saveLabel}</header> } })

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

test('IssueEditor: unreadable content is not editable and shows no typing hint or sync label', async () => {
  const { IssueEditor } = await import('../components/workspace/issue-editor')
  const { container, done } = await render(<IssueEditor issueId="issue-readonly" content={invalid} onChange={() => { throw new Error('no echo') }} layout="issue" syncLabel="" />)
  const prose = container.querySelector('.ProseMirror')
  assert.ok(prose, 'editor mounted')
  assert.equal(prose.getAttribute('contenteditable'), 'false')
  assert.equal(container.querySelectorAll('[data-placeholder]').length, 0)
  assert.ok(container.querySelector('#issue-comment'), 'a known task renders its activity')
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
  assert.ok(container.querySelector('#issue-comment'), 'the successful task read passes its stable id through IssueEditor')
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
      onComment={body => comments.push(body)} onReply={(id, body) => replies.push({ id, body })} onResolve={() => {}} onSelect={() => {}} />}</ViewStateProvider>
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
      assert.equal(editor.container.querySelector<HTMLTextAreaElement>('#issue-comment')?.value, 'Only restore after task access is confirmed')
    } finally { await editor.done() }
  } finally { await fixture.done() }
})

test('IssueActivity: a reply to a reply renders indented under the message it answers', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const nested: ThreadRecord[] = [{
    id: 'discussion-n', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [
      { id: 'n-1', author: 'Owner', authorUserId: 'owner', body: 'Root', at: '2026-11-07T08:00:00Z' },
      { id: 'n-2', author: 'Owner', authorUserId: 'owner', body: 'First answer', at: '2026-11-07T08:01:00Z', replyTo: 'n-1' },
      { id: 'n-3', author: 'Owner', authorUserId: 'owner', body: 'Answer to the answer', at: '2026-11-07T08:02:00Z', replyTo: 'n-2' },
    ],
  }]
  const { container, done } = await render(<ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-n" author="Owner" viewerId="owner" threads={nested} anchors={[]} onComment={() => {}} onReply={() => {}} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>, '#issue-comment')
  try {
    const bodies = [...container.querySelectorAll('p')].map(node => node.textContent).filter(body => ['Root', 'First answer', 'Answer to the answer'].includes(body ?? ''))
    // Every message draws once, and the deep answer follows the answer it belongs to.
    assert.deepEqual(bodies, ['Root', 'First answer', 'Answer to the answer'])
  } finally { await done() }
})

test('IssueActivity: edit and delete appear only on the reader\'s own comment', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const mine: ThreadRecord[] = [{
    id: 'discussion-o', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [{ id: 'o-1', author: 'Owner', authorUserId: 'owner', body: 'Mine', at: '2026-11-07T08:00:00Z' }],
  }]
  const view = (viewerId?: string) => <ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-o" author="Owner" viewerId={viewerId} threads={mine} anchors={[]} onComment={() => {}} onReply={() => {}} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>
  const asOwner = await render(view('owner'), '#issue-comment')
  try {
    assert.ok(asOwner.container.querySelector('[aria-label="editComment"]'), 'the author is offered edit')
    assert.ok(asOwner.container.querySelector('[aria-label="deleteComment"]'), 'the author is offered delete')
  } finally { await asOwner.done() }
  const asOther = await render(view('someone-else'), '#issue-comment')
  try {
    assert.equal(asOther.container.querySelector('[aria-label="editComment"]'), null, 'another reader is not offered edit')
    assert.equal(asOther.container.querySelector('[aria-label="deleteComment"]'), null, 'another reader is not offered delete')
  } finally { await asOther.done() }
})

test('IssueActivity: the author edits a comment in place and the change reaches the caller', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const edits: { threadId: string; messageId: string; body: string }[] = []
  const mine: ThreadRecord[] = [{
    id: 'discussion-e', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [{ id: 'e-1', author: 'Owner', authorUserId: 'owner', body: 'Before', at: '2026-11-07T08:00:00Z' }],
  }]
  const view = (onEdit: (threadId: string, messageId: string, body: string) => void) => <ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-e" author="Owner" viewerId="owner" threads={mine} anchors={[]} onComment={() => {}} onReply={() => {}} onEdit={onEdit} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>
  const { container, update, done } = await render(view((threadId, messageId, body) => { edits.push({ threadId, messageId, body }) }), '#issue-comment')
  const editField = () => container.querySelector<HTMLTextAreaElement>('#edit-e-1')
  try {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="editComment"]')!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    const box = editField()
    assert.ok(box, 'the author opens the edit field')
    await act(async () => {
      box.focus()
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'After')
      box.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
    })
    await act(async () => {
      box.closest('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    })
    assert.deepEqual(edits, [{ threadId: 'discussion-e', messageId: 'e-1', body: 'After' }])
    await update(view(() => {}))
    // Leaving the edit closes the field; nothing is written twice.
    assert.equal(editField(), null)
    assert.equal(edits.length, 1)
  } finally { await done() }
})

test('IssueActivity: writing a reply under one message sends that message as the target', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const replies: { id: string; body: string; replyTo?: string }[] = []
  const thread: ThreadRecord[] = [{
    id: 'discussion-r', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [
      { id: 'r-1', author: 'Owner', authorUserId: 'owner', body: 'Root', at: '2026-11-07T08:00:00Z' },
      { id: 'r-2', author: 'Owner', authorUserId: 'owner', body: 'Reply', at: '2026-11-07T08:01:00Z', replyTo: 'r-1' },
    ],
  }]
  const { container, done } = await render(<ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-r" author="Owner" viewerId="owner" threads={thread} anchors={[]} onComment={() => {}} onReply={(id, body, replyTo) => replies.push({ id, body, replyTo })} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>, '#issue-comment')
  try {
    // The message's own 回复 opens a box that answers that message, not the thread.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as Event)
    })
    const box = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find(node => node.id.startsWith('reply-r-'))
    assert.ok(box, 'the message under the reply opens its own box')
    await act(async () => {
      box.focus()
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Nested answer')
      box.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
    })
    await act(async () => {
      box.closest('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    })
    assert.equal(replies.length, 1)
    assert.equal(replies[0].body, 'Nested answer')
    assert.equal(replies[0].id, 'discussion-r')
    assert.equal(replies[0].replyTo, 'r-1')
    assert.equal(container.querySelector<HTMLTextAreaElement>('#reply-discussion-r')?.value, '', 'the thread footer box is untouched')
  } finally { await done() }
})

test('IssueActivity: a comment draws the files it carries with their names and sizes', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const withFiles: ThreadRecord[] = [{
    id: 'discussion-f', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [{ id: 'f-1', author: 'Owner', authorUserId: 'owner', body: 'See attached', at: '2026-11-07T08:00:00Z',
      attachments: [{ id: 'file-1', name: 'build.log', mediaType: 'text/plain', size: 2048 }, { id: 'file-2', name: 'trace.zip', mediaType: 'application/zip', size: 3 * 1024 * 1024 }] }],
  }]
  const { container, done } = await render(<ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-f" author="Owner" viewerId="owner" threads={withFiles} anchors={[]} onComment={() => {}} onReply={() => {}} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>, '#issue-comment')
  try {
    const text = container.textContent ?? ''
    assert.ok(text.includes('build.log'), 'the first file is named')
    assert.ok(text.includes('2.0 KB'), 'the first file shows its size')
    assert.ok(text.includes('trace.zip'), 'the second file is named')
    assert.ok(text.includes('3.0 MB'), 'the second file shows its size')
    // No download route serves issue files yet, so the row must not link somewhere that 404s.
    assert.equal(container.querySelector('a[href^="/api/issues/issue-f/files/"]'), null, 'no dead download link while the store is missing')
  } finally { await done() }
})

test('IssueActivity: a comment with no files draws no attachment row', async () => {
  const { IssueActivity } = await import('../components/workspace/issue-activity')
  const plain: ThreadRecord[] = [{
    id: 'discussion-p', author: 'Owner', createdAt: '2026-11-07T08:00:00Z', resolved: false,
    messages: [{ id: 'p-1', author: 'Owner', authorUserId: 'owner', body: 'Just words', at: '2026-11-07T08:00:00Z' }],
  }]
  const { container, done } = await render(<ViewStateProvider scope="owner:workspace-a"><IssueActivity issueId="issue-p" author="Owner" viewerId="owner" threads={plain} anchors={[]} onComment={() => {}} onReply={() => {}} onResolve={() => {}} onSelect={() => {}} /></ViewStateProvider>, '#issue-comment')
  try {
    assert.equal(container.querySelectorAll('a[download]').length, 0, 'a comment without files links nothing')
  } finally { await done() }
})
