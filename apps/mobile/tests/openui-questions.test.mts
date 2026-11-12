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

type FreeFieldProps = { accessibilityLabel: string; value: string; disabled?: boolean; onChangeText: (value: string) => void; onSubmitEditing: () => void }
const freeFields = new Map<string, FreeFieldProps>()
mock.module(new URL('../components/beui/components/input/index.ts', import.meta.url).href, { namedExports: {
  Input: (props: FreeFieldProps) => {
    freeFields.set(props.accessibilityLabel, props)
    return createElement('input', { 'aria-label': props.accessibilityLabel, value: props.value, disabled: props.disabled, readOnly: true })
  },
} })

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
const render = async (allowCustom: boolean, answer: (words: string) => Promise<boolean> = async words => { answers.push(words); return accepted }) => {
  const value = `root = BeQuestions("测试背景", [{id:"start", title:"先做什么？", options:[{value:"a", label:"整理收件箱"}, {value:"b", label:"查看日程"}], allowCustom:${allowCustom}}])`
  await act(async () => root.render(createElement(OpenUIReply, { text: value, live: true, answer, sources: {}, onOpen: () => {} })))
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

test('a slow native reply choice rejects simultaneous taps and permits retry after the transport throws', async () => {
  let reject!: (cause: Error) => void
  const attempted: string[] = []
  await render(false, async words => {
    attempted.push(words)
    if (attempted.length === 1) return new Promise<boolean>((_, fail) => { reject = fail })
    return true
  })
  const option = [...container.querySelectorAll('button')].find(row => row.textContent?.includes('查看日程'))!
  await act(async () => { option.click(); option.click() })
  assert.deepEqual(attempted, ['查看日程'])
  assert.equal(option.disabled, true)
  await act(async () => reject(new Error('connection lost')))
  assert.match(container.textContent ?? '', /没发出去/)
  assert.equal(option.disabled, false)
  await act(async () => option.click())
  assert.deepEqual(attempted, ['查看日程', '查看日程'])
  assert.equal(option.disabled, true)
})

test('two Eve requests retain independent drafts and send the addressed question once per acknowledgement', async () => {
  const { EveInteractions } = await import('../features/chat/components/eve-interactions')
  const left = '884dd24a-f4d1-4e5a-8cba-afbeadc20ebf', right = 'c3424412-e036-4476-9878-24490bfd3517'
  const calls: unknown[] = []
  let reject!: (failure: Error) => void
  let accept!: () => void
  const respond = (answers: unknown) => {
    calls.push(answers)
    return new Promise<void>((resolve, refuse) => { accept = resolve; reject = refuse })
  }
  const { emptySessionView, foldEvents } = await import('eve/events')
  const request = (interactionId: string, prompt: string, line: number) => ({
    type: 'interaction.opened',
    data: { interactionId, subject: { kind: 'call', callId: 'fixture' }, request: { kind: 'question', prompt, allowFreeform: true, options: [{ id: 'choose', label: prompt + ' option' }] } },
    meta: { position: { line, index: 0 }, at: new Date(0).toISOString() },
  })
  const view = foldEvents(emptySessionView(), [request(left, 'First', 0), request(right, 'Second', 1)])
  const agent = { view, respond, status: 'idle' } as unknown as Parameters<typeof EveInteractions>[0]['agent']
  await act(async () => root.render(createElement(EveInteractions, { agent })))

  const field = (name: string) => freeFields.get(name)!
  const sendButton = (name: string) => container.querySelector<HTMLInputElement>('input[aria-label="' + name + '"]')!.parentElement!.querySelector('button')!
  assert.equal(sendButton('Second').disabled, true)
  await act(async () => { field('First').onChangeText('retained'); field('Second').onChangeText('  second draft  ') })
  await act(async () => { field('Second').onSubmitEditing(); sendButton('Second').click(); button('Second option').click() })
  assert.deepEqual(calls, [[{ interactionId: right, text: 'second draft' }]])
  assert.equal(field('Second').disabled, true)
  assert.equal(field('First').disabled, false)
  await act(async () => reject(Object.assign(new Error('refused'), { status: 403 })))
  assert.equal(field('Second').value, '  second draft  ')
  assert.equal(field('First').value, 'retained')
  assert.ok(container.textContent?.includes((await import('../lib/messages')).mobileMessages.Coordinator.sendAccessDenied))
  await act(async () => sendButton('Second').click())
  assert.deepEqual(calls[1], calls[0])
  await act(async () => accept())
  assert.equal(sendButton('Second').disabled, true, 'receipt locks this request until its projection arrives')
  await act(async () => button('First option').click())
  assert.deepEqual(calls[2], [{ interactionId: left, optionId: 'choose' }])
  await act(async () => accept())
})

test('a settled native tree locks only its previously clicked generated control', async () => {
  const locked = new Set<string>(), writes: string[] = []
  const answer = async (_text: string, child: string) => {
    writes.push(child); locked.add(child)
    return true
  }
  const program = 'root = BeCard("Plan", [BeButton("First", "same"), BeButton("Second", "same")])'
  async function show(rowKey: string) {
    await act(async () => root.render(createElement(OpenUIReply, { key: rowKey, text: program, live: true,
      canAnswer: child => !locked.has(child), answer, sources: {}, onOpen: () => {} })))
  }
  await show('SDK')
  await act(async () => { button('First').click(); button('First').click() })
  await show('history')
  assert.equal(button('First').disabled, true)
  assert.equal(button('Second').disabled, false)
  await act(async () => button('Second').click())
  assert.deepEqual(writes, ['root.0', 'root.1'])
})

test('an unconfirmed custom answer keeps its editor when the live document settles', async () => {
  const { eveChatItems, generatedCardDocument } = await import('../features/chat/model/eve-messages')
  const program = 'root = BeQuestions("context", [{id:"q", title:"Reply?", options:[], allowCustom:true}])'
  const agent = { messages: [{ id: 'turn_1:assistant', role: 'assistant' as const, metadata: { turnId: 'turn_1' },
    parts: [{ type: 'text' as const, text: program }] }], events: [], session: { sessionId: 'wrun_bot' } }
  const [stream] = eveChatItems(agent, [])
  const saved = { ...stream, cardDocument: undefined, streamId: 'eve:wrun_bot:turn_1' }
  let refuse!: () => void
  const answer = () => new Promise<boolean>(resolve => { refuse = () => resolve(false) })
  async function show(row: typeof stream) {
    await act(async () => root.render(createElement(OpenUIReply, { key: generatedCardDocument(row), text: row.text,
      live: true, answer, sources: {}, onOpen: () => {} })))
  }
  await show(stream)
  await act(async () => edit('original answer'))
  await act(async () => button('提交回答并继续').click())
  const editor = container.querySelector('input')
  await show(saved)
  assert.equal(container.querySelector('input'), editor)
  await act(async () => refuse())
  assert.equal(editor?.value, 'original answer')
  assert.match(container.textContent ?? '', /没发出去/)
})
