import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act, type ReactElement } from 'react'
import { Window } from 'happy-dom'

// R-90: a person's own message bubble owns its shape, so the call sites that draw
// one do not each restyle BubbleContent to get it.
let browser: Window
let createRoot: typeof import('react-dom/client')['createRoot']
let BubbleContent: typeof import('./bubble')['BubbleContent']

before(async () => {
  browser = new Window({ url: 'https://mikka.test/mikka' })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
  })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ BubbleContent } = await import('./bubble'))
})

const classesOf = async (element: ReactElement) => {
  const container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  const node = container.querySelector('[data-slot="bubble-content"]') ?? container.firstElementChild
  const className = (node?.className ?? '') as string
  await act(async () => root.unmount())
  container.remove()
  return className
}

test('roomy is the person-message shape, and the default keeps the plain one', async () => {
  const roomy = await classesOf(<BubbleContent size="roomy">hi</BubbleContent>)
  assert.match(roomy, /\brounded-2xl\b/, 'roomy owns the wider radius')
  assert.match(roomy, /\bpx-4\b/, 'roomy owns the wider horizontal padding')
  assert.match(roomy, /\bpy-3\b/, 'roomy owns the taller vertical padding')

  const plain = await classesOf(<BubbleContent>hi</BubbleContent>)
  assert.match(plain, /\brounded-xl\b/, 'the default keeps its own radius')
  assert.doesNotMatch(plain, /\brounded-2xl\b/, 'the default is not the person-message shape')
  assert.doesNotMatch(plain, /\bpx-4\b/, 'the default keeps its narrower padding')
})
