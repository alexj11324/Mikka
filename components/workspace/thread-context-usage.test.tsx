import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { contextUsageFromCounts, type ContextCharSources } from '@/lib/context-usage'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) => {
  const text = key.split('.').reduce<unknown>((value, name) => (value as Record<string, unknown>)?.[name], zh[namespace])
  if (typeof text !== 'string') throw new Error(`missing copy: ${namespace}.${key}`)
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
} } })

// Loaded after the copy mock: the component reads next-intl at module load.
let ThreadContextUsage: typeof import('./thread-context-usage')['ThreadContextUsage']
before(async () => { ({ ThreadContextUsage } = await import('./thread-context-usage')) })

const usage = (over: Partial<ContextCharSources> = {}) => contextUsageFromCounts({
  // 40k ASCII characters is 10k estimated tokens: 40% of the brief's 25k cap.
  prompt: { ascii: 40_000, other: 0 }, task: { ascii: 400, other: 0 },
  messages: { ascii: 1_200, other: 0 }, conversation: { ascii: 8_000, other: 0 }, ...over,
})

test('the status line shows the brief against its cap, not a bare token count', () => {
  const html = renderToStaticMarkup(<ThreadContextUsage usage={usage()} />)
  assert.match(html, /data-slot="thread-context-usage"/)
  // 10k of the brief's 25k cap, the one ratio this host can state.
  assert.ok(html.includes('>上下文 10K<span aria-hidden="true">/</span>25K<'), html)
  // The button names both figures for a screen reader, not only its visible words.
  assert.match(html, /aria-label="上下文，提纲已用 10K，上限 25K"/)
})

test('the panel says the figures are an estimate and names what it cannot read', () => {
  const html = renderToStaticMarkup(<ThreadContextUsage usage={usage()} />)
  // A person comparing this with a bill must be told both of these.
  assert.match(html, /估算值，非计费口径/)
  // `指令` is measured here, so it is listed above, not among the gaps.
  assert.match(html, /未计入：系统、工具、技能、MCP、环境/)
})

test('the measured segments appear with their counts, beside the total held', () => {
  const html = renderToStaticMarkup(<ThreadContextUsage usage={usage()} />)
  assert.match(html, />对话</)
  assert.match(html, />指令</)
  // `held` is the brief plus everything said since, never one of them alone.
  assert.match(html, /全部持有/)
  assert.match(html, /data-value="40"/)
})

test('a new thread with nothing said yet still shows the task it was given', () => {
  const html = renderToStaticMarkup(<ThreadContextUsage usage={usage({ messages: { ascii: 0, other: 0 }, conversation: { ascii: 0, other: 0 } })} />)
  assert.match(html, /data-slot="thread-context-usage"/)
  // The brief alone is unchanged, so its share of the cap is too.
  assert.match(html, /data-value="40"/)
  // The issue task is the person's words, so it is conversation even before anyone replies.
  assert.match(html, />对话</)
  // And nothing is hidden behind a zero: the gaps are still named.
  assert.match(html, /未计入：系统、工具、技能、MCP、环境/)
})
