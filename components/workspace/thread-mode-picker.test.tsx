import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { threadModePicker, type ThreadModePickerView, type ThreadModeRead } from '@/lib/thread-mode/view'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, Record<string, string>>>
const copy = (namespace: string) => {
  const table = namespace.split('.').reduce<Record<string, unknown> | undefined>((node, part) => node?.[part] as Record<string, unknown> | undefined, zh)
  return (key: string, values: Record<string, unknown> = {}) =>
    String((table?.[key] as string | undefined) ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
}
mock.module('next-intl', { namedExports: { useTranslations: copy } })

let Content: typeof import('./thread-mode-picker')['ThreadModePickerContent']
let BadgeContent: typeof import('./thread-mode-picker')['ThreadModeFrozenBadgeContent']
before(async () => {
  ({ ThreadModePickerContent: Content, ThreadModeFrozenBadgeContent: BadgeContent } = await import('./thread-mode-picker'))
})

function pick(read: ThreadModeRead, active = false): ThreadModePickerView {
  const view = threadModePicker(read, active)
  assert.ok(view)
  return view
}

/** The label of the pressed segment, without the sliding indicator markup. */
function selectedLabel(html: string) {
  const button = html.match(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
  return button.replace(/<[^>]+>/g, '').trim()
}

test('three options are always shown; the stored mode is the selected segment', () => {
  const html = renderToStaticMarkup(<Content view={pick({ mode: 'ask', version: 2 })} />)
  for (const label of ['计划', '执行', '询问']) assert.ok(html.includes(label), label)
  assert.match(html, /data-slot="thread-mode"/)
  assert.equal(selectedLabel(html), '询问')
  assert.equal(html.match(/aria-pressed=/g)?.length, 3)
  assert.doesNotMatch(html, /data-locked/)
  assert.doesNotMatch(html, /线程运行中不可切换/)
  assert.doesNotMatch(html, /data-thread-mode-frozen/)
})

test('a running thread disables every option and says why in plain text', () => {
  const html = renderToStaticMarkup(<Content view={pick({ mode: 'plan', version: 1, frozenMode: 'plan', locked: true })} />)
  assert.match(html, /data-locked/)
  assert.match(html, /线程运行中不可切换/)
  assert.ok((html.match(/disabled=""/g)?.length ?? 0) >= 3)
})

test('the picker never draws the frozen mode; the header badge is the only place it appears', () => {
  const html = renderToStaticMarkup(<Content view={pick({ mode: 'execute', version: 4, frozenMode: 'ask' }, true)} />)
  assert.doesNotMatch(html, /data-thread-mode-frozen/)
  assert.doesNotMatch(html, /本次运行/)
  const badge = renderToStaticMarkup(<BadgeContent mode="ask" />)
  assert.match(badge, /data-thread-mode-frozen/)
  assert.match(badge, /本次运行：询问/)
  // No read or no frozen mode: nothing is drawn.
  assert.equal(renderToStaticMarkup(<BadgeContent mode={null} />), '')
  // The badge adds no switchable control.
  assert.equal(html.match(/aria-pressed=/g)?.length, 3)
})

test('a refused transition is shown as an alert and the selection stays the server value', () => {
  const html = renderToStaticMarkup(<Content view={pick({ mode: 'execute', version: 5 })} error="threadModeLocked" />)
  assert.match(html, /role="alert"/)
  assert.match(html, /线程正在运行，结束后再切换模式/)
  assert.equal(selectedLabel(html), '执行')
})

test('saving disables the group and marks the bar busy', () => {
  const html = renderToStaticMarkup(<Content view={pick({ mode: 'execute', version: 0 })} pending />)
  assert.match(html, /aria-busy="true"/)
  assert.ok((html.match(/disabled=""/g)?.length ?? 0) >= 3)
})
