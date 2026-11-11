import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const box = ({ children }: { children?: ReactNode }) => <>{children}</>
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module('@/components/ui/input-group', { namedExports: { InputGroup: box, InputGroupAddon: box, InputGroupButton: box, InputGroupTextarea: box } })
mock.module('@/components/ui/tooltip', { namedExports: {
  Tooltip: box,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children?: ReactNode }) => <>{render}{children}</>,
  TooltipContent: () => null,
} })
mock.module('@/components/ui/resizable-pane', { namedExports: { ResizablePane: box } })
mock.module('./browser-notes', { namedExports: { useBrowserNotes: () => null } })

const browser = new Window({ url: 'https://mikka.test/mikka', settings: { disableIframePageLoading: true } })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let pane: typeof import('./browser-pane')
const open = (address: string) => {
  assert.equal(typeof pane.openBrowserAddress, 'function')
  return pane.openBrowserAddress(address)
}
const render = async () => act(async () => root.render(<pane.BrowserPane inTab onClose={() => undefined} />))
const frame = () => container.querySelector('iframe')!
const address = () => container.querySelector('input[aria-label="address"]') as HTMLInputElement
const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement

before(async () => {
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  pane = await import('./browser-pane')
})
beforeEach(() => {
  browser.localStorage.clear()
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

test('an address requested before mount opens the real normalized iframe without duplicating initial history', async () => {
  assert.equal(open('example.org/preview'), true)
  await render()
  assert.equal(frame().getAttribute('src'), 'https://example.org/preview')
  assert.equal(address().value, 'https://example.org/preview')
  assert.equal(button('back').disabled, true)
})

test('mounted requests use normal browser history and explicitly reopening the same URL reloads its frame', async () => {
  await render()
  await act(async () => assert.equal(open('/first'), true))
  await act(async () => assert.equal(open('/second'), true))
  assert.equal(frame().getAttribute('src'), 'https://mikka.test/second')
  assert.equal(button('back').disabled, false)
  await act(async () => button('back').click())
  assert.equal(frame().getAttribute('src'), 'https://mikka.test/first')
  const previous = frame()
  await act(async () => assert.equal(open('/first'), true))
  assert.equal(frame().getAttribute('src'), 'https://mikka.test/first')
  assert.notEqual(frame(), previous)
})

test('unsupported schemes and plain search text never replace the loaded page', async () => {
  assert.equal(open('/safe'), true)
  await render()
  const previous = frame()
  for (const invalid of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'plain search text']) {
    await act(async () => assert.equal(open(invalid), false))
    assert.equal(frame(), previous)
  }
})

test('a consumed request does not override the last page when the browser remounts', async () => {
  assert.equal(open('/first'), true)
  await render()
  browser.localStorage.setItem('mikka:browser-url', 'https://mikka.test/newer-page')
  await act(async () => root.render(null))
  await render()
  assert.equal(frame().getAttribute('src'), 'https://mikka.test/newer-page')
})

test('the newest unread request is consumed when the browser mounts', async () => {
  assert.equal(open('/older'), true)
  assert.equal(open('/newer'), true)
  await render()
  assert.equal(frame().getAttribute('src'), 'https://mikka.test/newer')
  assert.equal(button('back').disabled, true)
})
