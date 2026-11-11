import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// TSX components load Lucide's require export; keep native SVG outside this DOM behavior fixture.
const require = createRequire(import.meta.url)

const view = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
const text = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
let edit: (value: string) => void
mock.module('react-native', { namedExports: {
  Platform: { OS: 'web' },
  StyleSheet: { create: (styles: unknown) => styles }, View: view,
  Pressable: ({ children, onPress, disabled }: { children: ReactNode; onPress: () => void; disabled?: boolean }) => createElement('button', { disabled, onClick: onPress }, children),
  TextInput: ({ value, onChangeText, placeholder, editable }: { value: string; onChangeText: (text: string) => void; placeholder: string; editable?: boolean }) => {
    edit = onChangeText
    return createElement('input', { value, placeholder, readOnly: editable === false, onChange: event => onChangeText(event.currentTarget.value) })
  },
  Image: () => null, Linking: { openURL: async () => {} },
} })
mock.module(require.resolve('lucide-react-native'), { namedExports: { ArrowUpRight: () => null, Check: () => null } })
mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text: text } })
mock.module(new URL('../components/chat.tsx', import.meta.url).href, { namedExports: { BotBubble: view } })
mock.module(new URL('../components/Markdown.tsx', import.meta.url).href, { namedExports: { Markdown: ({ text: words }: { text: string }) => createElement('p', null, words) } })
mock.module(new URL('../components/icons.tsx', import.meta.url).href, { namedExports: { Spinner: () => null } })
mock.module(new URL('../lib/images.ts', import.meta.url).href, { namedExports: { useImage: () => null } })
mock.module(new URL('../lib/web.ts', import.meta.url).href, { namedExports: { openOnWeb: async () => {} } })
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: {}, font: 'System', lift: {} } })

const browser = new Window({ url: 'https://fixture.invalid/' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let OpenUIReply: typeof import('../components/OpenUI.tsx')['OpenUIReply']
const answers: string[] = []
let accepted = true
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ OpenUIReply } = await import('../components/OpenUI.tsx'))
})
beforeEach(() => {
  answers.length = 0; accepted = true
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (allowCustom: boolean) => {
  const value = `root = BeQuestions("测试背景", [{id:"start", title:"先做什么？", options:[{value:"a", label:"整理收件箱"}, {value:"b", label:"查看日程"}], allowCustom:${allowCustom}}])`
  await act(async () => root.render(createElement(OpenUIReply, { text: value, live: true, answer: async words => { answers.push(words); return accepted }, sources: {}, onOpen: () => {} })))
}
const button = (label: string) => [...container.querySelectorAll('button')].find(button => button.textContent === label)!

test('one question with options and allowCustom accepts custom-only input and preserves it after a failed answer', async () => {
  await render(true)
  assert.ok(container.querySelector('input'), 'the custom answer field is rendered even for one single-choice question')
  assert.equal(button('提交回答并继续').disabled, true)
  await act(async () => edit('先准备会议材料'))
  assert.equal(button('提交回答并继续').disabled, false)
  accepted = false
  await act(async () => button('提交回答并继续').click())
  assert.match(answers[0], /先做什么？：先准备会议材料/)
  assert.match(container.textContent ?? '', /没发出去，再试一次/)
  assert.equal(container.querySelector('input')?.value, '先准备会议材料')
  assert.equal(button('提交回答并继续').disabled, false)
  accepted = true
  await act(async () => button('提交回答并继续').click())
  assert.equal(answers.length, 2)
  assert.equal(answers[1], answers[0])
  assert.equal(button('已提交').disabled, true)
})

test('an option and custom context are submitted together instead of prematurely sending on option selection', async () => {
  await render(true)
  await act(async () => button('整理收件箱').click())
  assert.equal(answers.length, 0)
  await act(async () => edit('先处理客户邮件'))
  await act(async () => button('提交回答并继续').click())
  assert.match(answers[0], /先做什么？：整理收件箱；先处理客户邮件/)
})

test('a single-choice card without custom input still sends its option directly', async () => {
  await render(false)
  assert.equal(container.querySelector('input'), null)
  const option = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('查看日程'))!
  await act(async () => option.click())
  assert.deepEqual(answers, ['查看日程'])
})
