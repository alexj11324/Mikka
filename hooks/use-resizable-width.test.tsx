import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { useResizableWidth, type ResizableWidth } from './use-resizable-width'

const browser = new Window({ url: 'https://mikka.example/en', width: 1600, height: 900 })
const KEY = 'mikka:test-width'
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let latest: ResizableWidth<number>

before(async () => {
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { browser.localStorage.clear(); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

function Column({ initial }: { initial: number }) {
  latest = useResizableWidth({ storageKey: KEY, min: 320, max: 'half', initial, edge: 'start' })
  return <p>{latest.width}</p>
}
const render = (initial: number) => act(async () => root.render(<Column initial={initial} />))

test('a default that arrives after the first render applies while the person has chosen no width', async () => {
  await render(360)
  assert.equal(latest.width, 360)
  await render(560)
  assert.equal(latest.width, 560)
})

test('a remembered width wins over the default, also one that arrives later', async () => {
  browser.localStorage.setItem(KEY, '400')
  await render(360)
  assert.equal(latest.width, 400)
  await render(560)
  assert.equal(latest.width, 400)
})

test('a width set by widening stays until reset, which goes back to the current default', async () => {
  await render(360)
  await act(async () => latest.resizeTo(520))
  await render(600)
  assert.equal(latest.width, 520)
  await act(async () => latest.reset())
  assert.equal(latest.width, 600)
  assert.equal(browser.localStorage.getItem(KEY), null)
})
