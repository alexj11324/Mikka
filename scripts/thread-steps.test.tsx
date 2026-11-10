import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')).IssueThreads
// Formats the real English messages (one/other plurals only), so the test follows en.json.
const plural = (message: string, count: number) => {
  const match = /^\{count, plural, one \{(.*)\} other \{(.*)\}\}$/.exec(message)
  assert.ok(match, `a plain one/other plural: ${message}`)
  return (count === 1 ? match[1] : match[2]).replace('#', String(count))
}
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string, args: { count: number }) => {
  assert.ok(['steps', 'stepsCommands', 'stepsTools'].includes(key), key)
  return plural(en[key], args.count)
} } })

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

test('a "Ran N commands · Called N tools" line opens to list each step and closes again', async () => {
  await act(async () => { root.render(<ThreadSteps steps={steps} />) })
  const trigger = container.querySelector('button')
  assert.ok(trigger, 'the line is a real button, so Enter and Space work')
  assert.equal(trigger.getAttribute('type'), 'button')
  assert.equal(trigger.textContent, 'Ran 1 command · Called 1 tool', 'says what ran, not which Agent')
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
