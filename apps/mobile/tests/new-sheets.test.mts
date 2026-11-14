import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)

// Alex 2026-11-08 on device: 新建群聊 opened with an empty body. Render both sheets with simple host components and
// check they draw their fields, and pin the sheet options that lay the form out below an opaque header.
type Props = { children?: ReactNode; accessibilityLabel?: string; placeholder?: string; onChangeText?: (text: string) => void; onPress?: () => void }
const View = ({ children }: Props) => createElement('div', null, children)
const Text = ({ children }: Props) => createElement('span', null, children)
const TextInput = ({ placeholder, accessibilityLabel, onChangeText }: Props) => createElement('input', { placeholder, 'aria-label': accessibilityLabel, onInput: event => onChangeText?.(event.currentTarget.value) })
const Pressable = ({ children, accessibilityLabel, onPress }: Props) => createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress }, typeof children === 'function' ? null : children)
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('react-native', { namedExports: { View, ScrollView: View, Text, TextInput, Pressable, Platform: { OS: 'ios' }, StyleSheet: { create: (s: unknown) => s } } })
let purpose: string | undefined
mock.module('expo-router', { namedExports: { useLocalSearchParams: () => ({ purpose }), useRouter: () => ({ back: () => {} }) } })
mock.module(require.resolve('lucide-react-native'), { namedExports: { Check: () => null, X: () => null } })
stub('../components/icons.tsx', { BotAvatar: () => createElement('i'), Spinner: () => null, BOT_COLORS: { encre: '#000', bleu: '#00f' }, BOT_PICKER_SHAPES: ['cercle', 'fleur'] })
stub('../components/NavBar.tsx', { NavBar: ({ title, right }: { title: string; right: { label: string; disabled: boolean; onPress: () => void } }) =>
  createElement('header', null, title, createElement('button', { disabled: right.disabled, onClick: right.onPress }, right.label)) })
stub('../components/ReadNotice.tsx', { ReadNotice: () => null })
stub('../components/Symbol.tsx', { Symbol: () => null })
stub('../components/Text.tsx', { Text })
stub('../components/ui.tsx', { Field: View, Group: ({ label, children }: { label: string; children: ReactNode }) => createElement('section', null, label, children) })
const writes: Array<{ path: string; input: unknown }> = []
const opened: string[] = []
stub('../lib/api.ts', { api: async (path: string, input: unknown) => { writes.push({path, input}); return { id: 'created-id' } }, ApiError: class extends Error {} })
stub('../lib/haptics.ts', { tap: () => {} })
stub('../lib/navigate.ts', { openChat: (path: string) => { opened.push(path) }, chatPath: (id: string) => `/bots/${id}` })
stub('../lib/theme.ts', { colors: {}, font: 'System' })
stub('../lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'w' }, bots: [{ id: 'c', name: 'Coordinator', coordinator: true }, { id: 'a', name: '设计师', color: 'bleu', shape: 'fleur' }, { id: 'b', name: '研究员' }] }, error: null, loading: false, reload: () => {} }) })

const { mobileMessages } = await import('../lib/messages.ts')
const { default: NewGroup } = await import('../app/new-group.tsx')
const { default: NewBot } = await import('../app/new-bot.tsx')
const { newSheetOptions } = await import('../lib/sheet-options.ts')

test('新建群聊 draws its name field and a row per bot, without the Coordinator', () => {
  const html = renderToStaticMarkup(createElement(NewGroup))
  assert.ok(html.includes(`placeholder="${mobileMessages.Shell.newGroup.name}"`))
  assert.match(html, /aria-label="设计师"/)
  assert.match(html, /aria-label="研究员"/)
  assert.doesNotMatch(html, /aria-label="Coordinator"/)
})

test('the standalone conversation sheet keeps the first selected Bot as lead and opens the returned UUID', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  purpose = 'conversation'
  try {
    await act(async () => root.render(createElement(NewGroup)))
    const field = host.querySelector('input')!
    assert.equal(field.placeholder, mobileMessages.Shell.createConversation.name)
    await act(async () => {
      field.value = 'A separate conversation'
      field.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
    })
    for (const label of ['Coordinator', '设计师']) {
      await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
    }
    const submit = host.querySelector('header button') as HTMLButtonElement
    assert.equal(submit.disabled, false)
    await act(async () => { submit.click(); submit.click() })
    assert.deepEqual(writes, [{ path: '/api/conversations', input: { method: 'POST', body: {
      workspaceId: 'w', title: 'A separate conversation', purpose: 'conversation', leadBotId: 'c',
      members: [{ memberType: 'bot', memberId: 'c' }, { memberType: 'bot', memberId: 'a' }],
    } } }])
    assert.deepEqual(opened, ['/groups/created-id'])
  } finally {
    purpose = undefined
    await act(async () => root.unmount())
    host.remove()
    await browser.happyDOM.close()
  }
})

test('新建 Bot draws its name field, shapes and colours', () => {
  const html = renderToStaticMarkup(createElement(NewBot))
  assert.match(html, /placeholder="名字"/)
  assert.match(html, /形状/)
  assert.match(html, /颜色/)
})

test('both sheets are full-height form sheets under an opaque header', () => {
  const options = newSheetOptions('page')
  assert.equal(options.presentation, 'formSheet')
  assert.deepEqual(options.sheetAllowedDetents, [1])
  assert.equal(options.headerTransparent, false)
  assert.deepEqual(options.contentStyle, { backgroundColor: 'page' })
})
