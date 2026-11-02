import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'https://mikka.example/' })
let closeOnEscape: typeof import('../hooks/use-focus-return')['closeOnEscape']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ closeOnEscape } = await import('../hooks/use-focus-return'))
})

/** A thread's frame: Esc goes back (←) unless it was pressed in a field, which it only leaves (decision 2026-11-02-0301, K2). */
function thread() {
  document.body.innerHTML = '<section id="thread"><h2 id="heading" tabindex="-1">Thread</h2><textarea id="composer"></textarea><a id="link" href="#x">Task</a></section>'
  const view = document.getElementById('thread') as HTMLElement
  let backs = 0
  // The handler React would call: the same fields a React keyboard event carries.
  view.addEventListener('keydown', native => {
    const event = { key: native.key, defaultPrevented: native.defaultPrevented, nativeEvent: native, currentTarget: view, target: native.target, preventDefault: () => native.preventDefault() }
    closeOnEscape(event as unknown as ReactKeyboardEvent<HTMLElement>, document.getElementById('heading'), () => { backs++ })
  })
  const press = (id: string) => {
    const target = document.getElementById(id) as HTMLElement
    target.focus()
    target.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event)
  }
  return { press, backs: () => backs, active: () => document.activeElement?.id }
}

test('Esc in an empty thread composer only leaves the field: focus moves to the heading and the thread stays open', () => {
  const view = thread()
  view.press('composer')
  assert.equal(view.backs(), 0)
  assert.equal(view.active(), 'heading')
})

test('Esc in a composer holding text leaves the field the same way, keeping the draft', () => {
  const view = thread()
  const composer = document.getElementById('composer') as HTMLTextAreaElement
  composer.value = 'half a reply'
  view.press('composer')
  assert.equal(view.backs(), 0)
  assert.equal(view.active(), 'heading')
  assert.equal(composer.value, 'half a reply')
})

test('Esc outside a field goes back, once per press', () => {
  const view = thread()
  view.press('link')
  assert.equal(view.backs(), 1)
  view.press('heading')
  assert.equal(view.backs(), 2)
})
