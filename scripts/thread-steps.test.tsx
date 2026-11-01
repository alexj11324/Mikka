import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')).IssueThreads
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string, args: { harness: string; count: number }) => {
  assert.equal(key, 'steps')
  assert.match(en.steps, /^Handed to \{harness\}/)
  return `Handed to ${args.harness} · ${args.count} ${args.count === 1 ? 'step' : 'steps'}`
} } })
// harnessLabel's module also reads threads through server actions; only the label matters here.
mock.module(new URL('../components/workspace/issue-threads.tsx', import.meta.url).href, { namedExports: { harnessLabel: (harness: string) => harness === 'claude_code' ? 'Claude Code' : harness } })

const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadSteps: typeof import('../components/workspace/thread-steps')['ThreadSteps']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadSteps } = await import('../components/workspace/thread-steps'))
})
beforeEach(() => { container = document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => { root.unmount() }); container.remove() })
after(() => { browser.close() })

const steps = [
  { id: 'a', name: 'Bash', detail: 'pnpm test', failed: false },
  { id: 'b', name: 'Edit', detail: 'lib/run.ts', failed: true },
]

test('a "Handed to … · N steps" line opens to list each step and closes again', async () => {
  await act(async () => { root.render(<ThreadSteps harness="claude_code" steps={steps} />) })
  const trigger = container.querySelector('button')
  assert.ok(trigger, 'the line is a real button, so Enter and Space work')
  assert.equal(trigger.getAttribute('type'), 'button')
  assert.equal(trigger.textContent, 'Handed to Claude Code · 2 steps')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  assert.doesNotMatch(container.textContent ?? '', /pnpm test/)

  await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
  assert.ok(panel, 'the button controls the list it opens')
  const rows = [...panel.querySelectorAll('li')].map(row => row.textContent)
  assert.deepEqual(rows, ['Bashpnpm test', 'Editlib/run.ts'])
  assert.match(panel.querySelectorAll('li')[1].querySelector('span')?.className ?? '', /text-destructive/, 'a failed step reads as failed')

  await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
})
