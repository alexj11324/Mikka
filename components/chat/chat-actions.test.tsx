import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createRef } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const copySuccess = mock.fn()
const copyError = mock.fn()
mock.module('sonner', { namedExports: { toast: { success: copySuccess, error: copyError } } })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })

const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let CopyAction: typeof import('./copy-action')['CopyAction']
let SelectionQuote: typeof import('./selection-quote')['SelectionQuote']
let selectedQuote: typeof import('./selection-quote')['selectedQuote']
const written: string[] = []
let refuse = false

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(browser.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { if (refuse) throw new Error('denied'); written.push(text) } } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CopyAction } = await import('./copy-action'))
  ;({ SelectionQuote, selectedQuote } = await import('./selection-quote'))
})
beforeEach(() => { written.length = 0; refuse = false; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getSelection()?.removeAllRanges() })
after(() => browser.happyDOM.close())

const frame = () => new Promise(resolve => setTimeout(resolve, 30))

test('复制 copies the text and turns into 已复制 for a moment', async () => {
  await act(async () => root.render(<CopyAction text={'**粗体** 和 `code`'} />))
  const button = container.querySelector('button')!
  assert.equal(button.getAttribute('aria-label'), 'AiElements.message.copy')
  await act(async () => { button.click(); await frame() })
  assert.deepEqual(written, ['**粗体** 和 `code`'])
  assert.equal(container.querySelector('button')!.getAttribute('aria-label'), 'AiElements.message.copied')
  assert.equal(container.querySelector('[data-copy-state]')!.getAttribute('data-copy-state'), 'copied')
  // 「已复制」 shows beside the tick without a hover (Figma C5).
  assert.match(document.body.textContent ?? '', /AiElements\.message\.copied/)
})

test('a refused clipboard says 复制失败, never 已复制', async () => {
  refuse = true
  await act(async () => root.render(<CopyAction text="x" />))
  await act(async () => { container.querySelector('button')!.click(); await frame() })
  assert.equal(written.length, 0)
  assert.equal(container.querySelector('button')!.getAttribute('aria-label'), 'AiElements.message.copyFailed')
})

/** Selects the whole text of `node`. */
function select(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

test('only words selected inside a reply can be quoted', async () => {
  container.innerHTML = '<div data-quote-source=""><p id="reply">先把首页截图放大</p></div><p id="mine">我自己的话</p>'
  assert.equal(selectedQuote(container, select(container.querySelector('#reply')!))?.text, '先把首页截图放大')
  assert.equal(selectedQuote(container, select(container.querySelector('#mine')!)), null)
  document.getSelection()!.removeAllRanges()
  assert.equal(selectedQuote(container, document.getSelection()), null)
})

test('引用 / 复制 shows once the pointer lets go of a selection and hands the words over', async () => {
  const quoted: string[] = []
  const holder = createRef<HTMLDivElement>()
  await act(async () => root.render(<div ref={holder}><div data-quote-source=""><p id="reply">要整宽还是半宽</p></div><SelectionQuote root={holder} onQuote={text => quoted.push(text)} /></div>))
  await act(async () => { document.dispatchEvent(new browser.PointerEvent('pointerdown') as unknown as Event); select(container.querySelector('#reply')!); await frame() })
  // Still dragging: nothing shows yet.
  assert.equal(document.querySelector('[data-slot="selection-actions"]'), null)
  await act(async () => { document.dispatchEvent(new browser.PointerEvent('pointerup') as unknown as Event); await frame() })
  // The Artifact reader's popover: 引用 and 复制.
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="selection-actions"] button')]
  assert.deepEqual(buttons.map(button => button.textContent), ['Artifact.quote', 'Artifact.copy'])
  await act(async () => { buttons[0].click(); await frame() })
  assert.deepEqual(quoted, ['要整宽还是半宽'])
  assert.equal(document.querySelector('[data-slot="selection-actions"]'), null)
})

test('a refused copy of selected words preserves the action and can be retried', async () => {
  const holder = createRef<HTMLDivElement>()
  await act(async () => root.render(<div ref={holder}><p data-quote-source="">Selected words</p><SelectionQuote root={holder} onQuote={() => {}} /></div>))
  await act(async () => { select(container.querySelector('p')!); document.dispatchEvent(new browser.PointerEvent('pointerup') as unknown as Event); await frame() })
  const copy = document.querySelectorAll<HTMLButtonElement>('[data-slot="selection-actions"] button')[1]
  refuse = true
  await act(async () => { copy.click(); await frame() })
  assert.deepEqual(written, [])
  assert.equal(copySuccess.mock.callCount(), 0)
  assert.equal(copyError.mock.calls.at(-1)?.arguments[0], 'Artifact.copyFailed')
  assert.ok(copy.isConnected)
  assert.equal(document.getSelection()?.toString(), 'Selected words')

  refuse = false
  await act(async () => { copy.click(); await frame() })
  assert.deepEqual(written, ['Selected words'])
  assert.equal(copySuccess.mock.calls.at(-1)?.arguments[0], 'Artifact.copied')
  const failureToast = copyError.mock.calls.at(-1)?.arguments[1]
  assert.ok(failureToast?.id)
  assert.deepEqual(copySuccess.mock.calls.at(-1)?.arguments[1], failureToast)
  assert.equal(document.querySelector('[data-slot="selection-actions"]'), null)
})

test('Esc puts the popover away', async () => {
  const holder = createRef<HTMLDivElement>()
  await act(async () => root.render(<div ref={holder}><div data-quote-source=""><p id="reply">一段回答</p></div><SelectionQuote root={holder} onQuote={() => {}} /></div>))
  await act(async () => { select(container.querySelector('#reply')!); document.dispatchEvent(new browser.PointerEvent('pointerup') as unknown as Event); await frame() })
  assert.ok(document.querySelector('[data-slot="selection-actions"]'))
  await act(async () => { document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event); await frame() })
  assert.equal(document.querySelector('[data-slot="selection-actions"]'), null)
})
