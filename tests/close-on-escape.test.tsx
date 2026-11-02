import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let closeOnEscape: typeof import('../hooks/use-focus-return')['closeOnEscape']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, KeyboardEvent: browser.KeyboardEvent, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ closeOnEscape } = await import('../hooks/use-focus-return'))
})

/** A thread's frame: Esc goes back (←) unless it was pressed in a field, which it only leaves (decision 2026-11-02-0301, K2). */
async function thread() {
  const host = document.createElement('div')
  document.body.append(host)
  let backs = 0
  const root = createRoot(host)
  await act(async () => root.render(
    <section onKeyDown={event => closeOnEscape(event, document.getElementById('heading'), () => { backs++ })}>
      <h2 id="heading" tabIndex={-1}>Thread</h2>
      <textarea id="composer" defaultValue="" />
      <button id="button" type="button">Send</button>
    </section>,
  ))
  const press = async (id: string) => {
    const target = document.getElementById(id) as HTMLElement
    target.focus()
    await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  }
  return { press, backs: () => backs, active: () => document.activeElement?.id, unmount: () => act(async () => root.unmount()) }
}

test('Esc in an empty thread composer only leaves the field: focus moves to the heading and the thread stays open', async () => {
  const view = await thread()
  await view.press('composer')
  assert.equal(view.backs(), 0)
  assert.equal(view.active(), 'heading')
  await view.unmount()
})

test('Esc in a composer holding text leaves the field the same way, keeping the draft', async () => {
  const view = await thread()
  const composer = document.getElementById('composer') as HTMLTextAreaElement
  composer.value = 'half a reply'
  await view.press('composer')
  assert.equal(view.backs(), 0)
  assert.equal(view.active(), 'heading')
  assert.equal(composer.value, 'half a reply')
  await view.unmount()
})

test('Esc outside a field goes back, once', async () => {
  const view = await thread()
  await view.press('button')
  assert.equal(view.backs(), 1)
  await view.press('heading')
  assert.equal(view.backs(), 2)
  await view.unmount()
})
