import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// Decision K2: in a thread, Esc only leaves the composer; stopping the thread is the button.
// A bot chat keeps Esc as stop.
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ChatComposer: typeof import('../components/coordinator/chat-composer')['ChatComposer']
let IntlProvider: typeof import('next-intl')['IntlProvider']
before(async () => {
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator }))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ IntlProvider } = await import('next-intl'))
  ;({ ChatComposer } = await import('../components/coordinator/chat-composer'))
})
beforeEach(() => { container = document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => { root.unmount() }); container.remove() })
after(() => { browser.close() })

async function pressEscape(escapeStops: boolean | undefined) {
  let stops = 0
  await act(async () => {
    root.render(<IntlProvider locale="en" timeZone="UTC" messages={messages}>
      <ChatComposer ref={null} label="Tell Claude Code what to do next…" value="" onChange={() => {}} onSubmit={() => {}} running onStop={() => { stops++ }} {...(escapeStops === undefined ? {} : { escapeStops })} />
    </IntlProvider>)
  })
  const box = container.querySelector('textarea')!
  box.focus()
  assert.equal(document.activeElement, box)
  await act(async () => { box.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event) })
  return { stops, focused: document.activeElement === box }
}

test('in a bot chat Esc stops the reply, as before', async () => {
  assert.deepEqual(await pressEscape(undefined), { stops: 1, focused: true })
})

test('in a thread Esc only leaves the composer; it never stops the thread', async () => {
  assert.deepEqual(await pressEscape(false), { stops: 0, focused: false })
})
