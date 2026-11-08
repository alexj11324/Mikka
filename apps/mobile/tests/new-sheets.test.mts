import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)

// Alex 2026-11-08 on device: 新建群聊 opened with an empty body. Render both sheets with simple host components and
// check they draw their fields, and pin the sheet options that lay the form out below an opaque header.
type Props = { children?: ReactNode; accessibilityLabel?: string; placeholder?: string }
const View = ({ children }: Props) => createElement('div', null, children)
const Text = ({ children }: Props) => createElement('span', null, children)
const TextInput = ({ placeholder, accessibilityLabel }: Props) => createElement('input', { placeholder, 'aria-label': accessibilityLabel })
const Pressable = ({ children, accessibilityLabel }: Props) => createElement('button', { 'aria-label': accessibilityLabel }, typeof children === 'function' ? null : children)
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('react-native', { namedExports: { View, ScrollView: View, Text, TextInput, Pressable, Platform: { OS: 'ios' }, StyleSheet: { create: (s: unknown) => s } } })
mock.module('expo-router', { namedExports: { useRouter: () => ({ back: () => {} }) } })
mock.module(require.resolve('lucide-react-native'), { namedExports: { Check: () => null, X: () => null } })
stub('../components/icons.tsx', { BotAvatar: () => createElement('i'), Spinner: () => null, BOT_COLORS: { encre: '#000', bleu: '#00f' }, BOT_PICKER_SHAPES: ['cercle', 'fleur'] })
stub('../components/NavBar.tsx', { NavBar: ({ title }: { title: string }) => createElement('header', null, title) })
stub('../components/ReadNotice.tsx', { ReadNotice: () => null })
stub('../components/Symbol.tsx', { Symbol: () => null })
stub('../components/Text.tsx', { Text })
stub('../components/ui.tsx', { Field: View, Group: ({ label, children }: { label: string; children: ReactNode }) => createElement('section', null, label, children) })
stub('../lib/api.ts', { api: async () => ({}), ApiError: class extends Error {} })
stub('../lib/haptics.ts', { tap: () => {} })
stub('../lib/navigate.ts', { openChat: () => {}, chatPath: (id: string) => `/bots/${id}` })
stub('../lib/theme.ts', { colors: {}, font: 'System' })
stub('../lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'w' }, bots: [{ id: 'c', name: 'Coordinator', coordinator: true }, { id: 'a', name: '设计师', color: 'bleu', shape: 'fleur' }, { id: 'b', name: '研究员' }] }, error: null, loading: false, reload: () => {} }) })

const { default: NewGroup } = await import('../app/new-group.tsx')
const { default: NewBot } = await import('../app/new-bot.tsx')
const { newSheetOptions } = await import('../lib/sheet-options.ts')

test('新建群聊 draws its name field and a row per bot, without the Coordinator', () => {
  const html = renderToStaticMarkup(createElement(NewGroup))
  assert.match(html, /placeholder="群聊名称"/)
  assert.match(html, /aria-label="设计师"/)
  assert.match(html, /aria-label="研究员"/)
  assert.doesNotMatch(html, /aria-label="Coordinator"/)
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
