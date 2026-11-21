import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { contextUsageFromCounts, type ContextCharSources } from '@/lib/context-usage'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<unknown>((value, name) => (value as Record<string, unknown>)?.[name], zh[namespace])
  if (typeof text !== 'string') throw new Error(`missing copy: ${namespace}.${key}`)
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
} } })

const page = new Window({ url: 'https://example.invalid/mikka' })
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadContextUsage: typeof import('./thread-context-usage')['ThreadContextUsage']

before(async () => {
  Object.assign(globalThis, { window: page, document: page.document, IS_REACT_ACT_ENVIRONMENT: true })
  for (const key of ['navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: page[key] })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadContextUsage } = await import('./thread-context-usage'))
  root = createRoot(document.body)
})
after(async () => {
  await act(async () => root.unmount())
  await page.happyDOM.close()
})

const usage = (over: Partial<ContextCharSources> = {}) => contextUsageFromCounts({
  // 40k ASCII characters is 10k estimated tokens: 40% of the brief's 25k cap.
  prompt: { ascii: 40_000, other: 0 }, task: { ascii: 400, other: 0 },
  messages: { ascii: 1_200, other: 0 }, conversation: { ascii: 8_000, other: 0 }, ...over,
})

test('the status line shows the brief estimate and opens its measured and unmeasured segments', async () => {
  await act(async () => root.render(<ThreadContextUsage usage={usage()} />))
  const trigger = document.querySelector('button')!
  assert.equal(trigger.textContent, '上下文 10K/25K')
  assert.equal(trigger.getAttribute('aria-label'), '上下文，提纲已用 10K，上限 25K')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  await act(async () => trigger.click())
  const panel = document.querySelector<HTMLElement>('[role="dialog"]')
  assert.ok(panel)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.match(panel.textContent, /估算值，非计费口径/)
  assert.match(panel.textContent, /未计入：系统、工具、技能、MCP、环境/)
  assert.match(panel.textContent, /全部持有/)
  assert.deepEqual([...panel.querySelectorAll('li')].map(row => row.textContent), ['指令9.9K', '线程2.4K'])
  assert.equal(panel.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '40')

  const beforeFirstReply = usage({ messages: { ascii: 0, other: 0 }, conversation: { ascii: 0, other: 0 } })
  await act(async () => root.render(<ThreadContextUsage usage={beforeFirstReply} />))
  assert.deepEqual([...panel.querySelectorAll('li')].map(row => row.textContent), ['指令9.9K', '线程100'])
  assert.match(panel.textContent, /未计入：系统、工具、技能、MCP、环境/)
  assert.equal(panel.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '40')
})
