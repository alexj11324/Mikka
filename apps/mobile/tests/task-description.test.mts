import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages } from '../lib/messages.ts'

mock.module('react-native', { namedExports: { View: ({ children }: { children: ReactNode }) => createElement('section', null, children) } })
mock.module(new URL('../components/Markdown.tsx', import.meta.url).href, { namedExports: { Markdown: ({ text }: { text: string }) => createElement('p', null, text) } })
mock.module(new URL('../components/settings.tsx', import.meta.url).href, { namedExports: { Row: ({ label, expanded, onPress }: {
  label: string; expanded: boolean; onPress: () => void
}) => createElement('button', { 'aria-expanded': expanded, onClick: onPress }, label) } })
const { TaskDescription } = await import('../features/tasks/components/task-description.tsx')

test('Native legacy machine instructions open in full, collapse again, and ordinary long descriptions stay visible', async () => {
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
  } finally { await act(async () => root.unmount()); host.remove(); await browser.happyDOM.close() }
})
