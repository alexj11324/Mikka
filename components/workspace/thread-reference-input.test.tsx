import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, useRef, useState } from 'react'
import { Window } from 'happy-dom'

const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')

mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module(new URL('../../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { findThreadReferences: async () => [] } })
const { ThreadReferencePicker } = await import('./thread-references')

test('the thread picker observes the caret after the composer accepts each edit, including replacement of a restored draft', async () => {
  const root = createRoot(document.body)
  let accepted = 'previous PR draft'
  const caretReads: string[] = []
  function Composer() {
    const [draft, setDraft] = useState(accepted)
    const input = useRef<HTMLTextAreaElement>(null)
    return <><textarea aria-label="Thread" ref={input} value={draft} onChange={event => {
      accepted = event.currentTarget.value
      setDraft(accepted)
    }} /><ThreadReferencePicker input={input} draft={draft} onChange={setDraft} workspaceId="workspace" /><textarea aria-label="Other" /></>
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
