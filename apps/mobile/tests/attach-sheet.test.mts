import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createElement, useEffect, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// TSX components load Lucide's require export; keep native SVG outside this DOM behavior fixture.
const require = createRequire(import.meta.url)

const view = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
const text = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
const presses = new Map<string, () => void>()
const platform = { OS: 'ios' }
const words = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(words).join('') : node && typeof node === 'object' && 'props' in node ? words((node.props as { children?: ReactNode }).children) : ''
mock.module('react-native', { namedExports: {
  Platform: platform,
  StyleSheet: { create: (styles: unknown) => styles }, View: view,
  Pressable: ({ children, onPress, disabled }: { children: ReactNode; onPress: () => void; disabled?: boolean }) => {
    presses.set(words(children), onPress)
    return createElement('button', { disabled, onClick: onPress }, children)
  },
} })
mock.module(require.resolve('lucide-react-native'), { namedExports: { Camera: () => null, FileText: () => null, Image: () => null } })
mock.module('expo-clipboard', { namedExports: { ClipboardPasteButton: () => null, isPasteButtonAvailable: false } })
mock.module(new URL('../components/Symbol.tsx', import.meta.url).href, { namedExports: { Symbol: () => null } })
mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text: text } })
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: {} } })
mock.module(new URL('../components/ui.tsx', import.meta.url).href, { namedExports: { CloseButton: ({ onPress }: { onPress: () => void }) => createElement('button', { onClick: onPress, 'aria-label': '关闭' }, '关闭') } })
let blur: () => void
let backCalls = 0, picks = 0
let pick: () => Promise<void>
mock.module('expo-router', { namedExports: {
  useRouter: () => ({ canGoBack: () => true, back: () => { backCalls++ } }),
  useFocusEffect: (effect: () => () => void) => useEffect(() => { const cleanup = effect(); blur = cleanup; return cleanup }, [effect]),
} })
mock.module(new URL('../lib/attach-sheet.ts', import.meta.url).href, { namedExports: {
  heldComposer: () => ({ images: true, pick: () => { picks++; return pick() } }),
} })

const browser = new Window({ url: 'https://fixture.invalid/' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let AttachSheet: typeof import('../app/attach.tsx')['default']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ default: AttachSheet } = await import('../app/attach.tsx'))
})
beforeEach(() => {
  platform.OS = 'ios'; picks = 0; backCalls = 0; presses.clear(); pick = async () => {}
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async () => { await act(async () => root.render(createElement(AttachSheet))) }

test('one picker runs at a time and closes only the sheet that is still focused', async () => {
  let finish!: () => void
  pick = () => new Promise(resolve => { finish = resolve })
  await render()
  const choose = presses.get('照片')!
  await act(async () => { choose(); choose() })
  assert.equal(picks, 1)
  assert.ok([...container.querySelectorAll('button')].every(button => button.disabled))
  await act(async () => finish())
  assert.equal(backCalls, 1)
})

for (const leave of ['blur', 'unmount'] as const) test(`a late picker result cannot navigate back after ${leave}`, async () => {
  let finish!: () => void
  pick = () => new Promise(resolve => { finish = resolve })
  await render()
  await act(async () => presses.get('照片')!())
  await act(async () => { if (leave === 'blur') blur(); else root.render(null) })
  await act(async () => finish())
  assert.equal(backCalls, 0)
})

test('a picker exception keeps the sheet open with visible recovery and releases the busy guard', async () => {
  pick = async () => { throw new Error('picker unavailable') }
  await render()
  await act(async () => presses.get('文件')!())
  assert.equal(backCalls, 0)
  assert.match(container.textContent ?? '', /无法添加附件，请重新选择/)
  assert.ok([...container.querySelectorAll('button')].every(button => !button.disabled))
  pick = async () => {}
  await act(async () => presses.get('文件')!())
  assert.equal(picks, 2)
  assert.equal(backCalls, 1)
})


test('Web has an explicit close action and a later picker completion cannot navigate twice', async () => {
  platform.OS = 'web'
  let finish!: () => void
  pick = () => new Promise(resolve => { finish = resolve })
  await render()
  assert.match(container.textContent ?? '', /添加附件/)
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
  assert.ok(close, 'Web has no native form-sheet dismissal gesture')
  await act(async () => presses.get('照片')!())
  assert.equal(close.disabled, false, 'cancel remains available during image processing')
  await act(async () => close.click())
  assert.equal(backCalls, 1)
  await act(async () => finish())
  assert.equal(backCalls, 1)
})
