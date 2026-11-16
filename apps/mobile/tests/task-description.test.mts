import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages } from '../lib/messages.ts'

const text = ({ children }: { children?: ReactNode }) => createElement('p', null, children)
mock.module('react-native', { namedExports: {
  View: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  Text: text, StyleSheet: { create: (styles: unknown) => styles }, Linking: { openURL: async () => {} },
} })
mock.module(createRequire(import.meta.url).resolve('lucide-react-native'), { namedExports: { CircleDot: () => null } })
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: {}, font: 'System' } })
mock.module(new URL('../components/icons.tsx', import.meta.url).href, { namedExports: { StatusIcon: () => null } })
mock.module(new URL('../components/ChatFiles.tsx', import.meta.url).href, { namedExports: { ChatFiles: () => null } })
mock.module(new URL('../features/chat/components/chat-images.tsx', import.meta.url).href, { namedExports: { ChatImages: () => null } })
mock.module(new URL('../features/chat/model/chat-image-source.ts', import.meta.url).href, { namedExports: { isImageFile: () => false, useImageFiles: () => [] } })
mock.module(new URL('../components/settings.tsx', import.meta.url).href, { namedExports: { Row: ({ label, expanded, onPress }: {
  label: string; expanded: boolean; onPress: () => void
}) => createElement('button', { 'aria-expanded': expanded, onClick: onPress }, label) } })
const { TaskDescription } = await import('../features/tasks/components/task-description.tsx')

test('Native Task descriptions expand legacy instructions and render ordinary text and escaped mention names', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    const contract = 'SHA256 file contract\n' + 'original words '.repeat(85)
    await act(async () => root.render(createElement(TaskDescription, { body: contract, key: 'legacy' })))
    const toggle = host.querySelector('button')!
    assert.equal(toggle.textContent, mobileMessages.Editor.executionInstructions)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(host.querySelector('p'), null)
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(host.querySelector('p')?.textContent, contract)
    await act(async () => toggle.click())
    assert.equal(host.querySelector('p'), null)
    const ordinary = 'A human requested this. '.repeat(52)
    await act(async () => root.render(createElement(TaskDescription, { body: ordinary, key: 'ordinary' })))
    assert.equal(host.querySelector('button'), null)
    assert.equal(host.querySelector('p')?.textContent, ordinary)
    await act(async () => root.render(createElement(TaskDescription, { body: 'Ask @Rin \\[QA\\] and @A\\_B today.', key: 'mentions' })))
    assert.equal(host.textContent, 'Ask @Rin [QA] and @A_B today.')
  } finally { await act(async () => root.unmount()); host.remove(); await browser.happyDOM.close() }
})
