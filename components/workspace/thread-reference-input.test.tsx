import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, useRef, useState } from 'react'
import { Window } from 'happy-dom'
import { Textarea } from '../ui/textarea'

const sharedId = '20000000-0000-4000-8000-000000000002'
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
Object.assign(globalThis, { requestAnimationFrame: browser.requestAnimationFrame.bind(browser) })

mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key, useFormatter: () => ({}) } })
mock.module(new URL('../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { findThreadReferences: async () => [
  { kind: 'thread', conversationKind: 'chat', id: sharedId, title: 'Standalone conversation' },
  { kind: 'thread', id: sharedId, title: 'Execution run' },
] } })
const { ThreadReferencePicker, PersonReferences } = await import('./thread-references')
const { ConversationReferenceTitles, conversationReferenceTitles } = await import('./conversation-reference-titles')

test('the thread picker observes the caret after the composer accepts each edit, including replacement of a restored draft', async () => {
  const root = createRoot(document.body)
  let accepted = 'previous PR draft'
  const caretReads: string[] = []
  function Composer() {
    const [draft, setDraft] = useState(accepted)
    const input = useRef<HTMLTextAreaElement>(null)
    return <><Textarea aria-label="Thread" ref={input} value={draft} onChange={event => {
      accepted = event.currentTarget.value
      setDraft(accepted)
    }} /><ThreadReferencePicker input={input} draft={draft} onChange={setDraft} workspaceId="workspace" /><Textarea aria-label="Other" /></>
  }
  try {
    await act(async () => root.render(<Composer />))
    const input = browser.document.querySelector('textarea[aria-label="Thread"]')
    const other = browser.document.querySelector('textarea[aria-label="Other"]')
    assert.ok(input instanceof browser.HTMLTextAreaElement && other instanceof browser.HTMLTextAreaElement)
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set
    const getCaret = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'selectionStart')?.get
    assert.ok(setValue && getCaret)
    Object.defineProperty(input, 'selectionStart', { configurable: true, get() { caretReads.push(accepted); return getCaret.call(input) } })
    for (const next of ['', '@f', '@file:private']) {
      setValue.call(input, next)
      caretReads.length = 0
      await act(async () => { input.dispatchEvent(new browser.Event('input', { bubbles: true })) })
      assert.ok(caretReads.length > 0)
      assert.ok(caretReads.every(value => value === next), 'a pending caret update must not observe the previous controlled draft')
      assert.equal(input.value, next)
    }
    assert.equal(browser.document.querySelector('[role="status"]')?.textContent, 'sourceUnavailable')
    caretReads.length = 0
    await act(async () => { other.dispatchEvent(new browser.Event('input', { bubbles: true })) })
    assert.deepEqual(caretReads, [])
  } finally {
    await act(async () => root.unmount())
    await browser.happyDOM.abort()
  }
})

test('authorized Chat and Run results sharing a UUID keep their own buttons and insert their distinct references', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const root = createRoot(document.body)
  function Composer() {
    const [draft, setDraft] = useState('@thread:shared')
    const input = useRef<HTMLTextAreaElement>(null)
    return <><Textarea ref={input} value={draft} onChange={event => setDraft(event.currentTarget.value)} />
      <ThreadReferencePicker input={input} draft={draft} onChange={setDraft} workspaceId="workspace" /></>
  }
  try {
    for (const [index, [title, kind]] of [['Standalone conversation', 'chat'], ['Execution run', 'run']].entries()) {
      await act(async () => root.render(<Composer key={index} />))
      const input = browser.document.querySelector('textarea')!
      input.setSelectionRange(input.value.length, input.value.length)
      await act(async () => { input.dispatchEvent(new browser.Event('click', { bubbles: true })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
      const buttons = Array.from(browser.document.querySelectorAll('button'))
      assert.equal(buttons.length, 2)
      const button = buttons.find(node => node.textContent?.includes(title))
      assert.ok(button)
      await act(async () => button.click())
      assert.equal(input.value, `[[${kind}:${sharedId}]] `)
    }
    assert.equal(errors.mock.calls.filter(call => String(call.arguments[0]).includes('same key')).length, 0)
  } finally { await act(async () => root.unmount()) }
})

test('links in a person’s message follow authorized titles after a rename and forget them on workspace or identity changes', async () => {
  const root = createRoot(document.body)
  const title = (run: string, chat: string, viewer = 'owner', workspace = 'team') => conversationReferenceTitles(viewer, workspace, {
    live: { ownerId: 'owner', workspaceId: 'team' }, items: [{ id: sharedId, title: run }],
  }, viewer === 'owner' ? [{ id: sharedId, workspaceId: 'team', creationPurpose: 'conversation', title: chat, createdAt: '', lastMessage: null }] : [])
  const render = async (names: ReadonlyMap<string, string>) => {
    await act(async () => root.render(<ConversationReferenceTitles value={names}><PersonReferences text={`[[run:${sharedId}]] and [[chat:${sharedId}]]`} /></ConversationReferenceTitles>))
    return [...document.body.querySelectorAll('a')].map(a => a.textContent)
  }
  try {
    assert.deepEqual(await render(title('Earlier run', 'Earlier conversation')), ['Earlier run', 'Earlier conversation'])
    assert.deepEqual(await render(title('Renamed run', 'Renamed conversation')), ['Renamed run', 'Renamed conversation'])
    const fallback = ['thread ' + sharedId.slice(0, 8), 'thread ' + sharedId.slice(0, 8)]
    assert.deepEqual(await render(title('Private run', 'Private conversation', 'owner', 'other')), fallback)
    assert.deepEqual(await render(title('Private run', 'Private conversation', 'member')), fallback)
  } finally { await act(async () => root.unmount()) }
})
