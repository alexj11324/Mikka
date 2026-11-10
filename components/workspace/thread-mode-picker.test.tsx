import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { threadModePicker, type ThreadModePickerView, type ThreadModeRead, type ThreadModeSupport } from '@/lib/thread-mode/view'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, Record<string, string>>>
const copy = (namespace: string) => {
  const table = namespace.split('.').reduce<Record<string, unknown> | undefined>((node, part) => node?.[part] as Record<string, unknown> | undefined, zh)
  return (key: string, values: Record<string, unknown> = {}) =>
    String((table?.[key] as string | undefined) ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
}
mock.module('next-intl', { namedExports: { useTranslations: copy } })

let Picker: typeof import('./thread-mode-picker')['ThreadModePickerContent']
let Notice: typeof import('./thread-mode-picker')['ThreadModeNoticeContent']
before(async () => {
  ({ ThreadModePickerContent: Picker, ThreadModeNoticeContent: Notice } = await import('./thread-mode-picker'))
})

const enforced: ThreadModeSupport = {
  plan: { state: 'enforced' }, execute: { state: 'enforced' }, ask: { state: 'enforced' },
}

function pick(read: Omit<ThreadModeRead, 'support'> & { support?: ThreadModeSupport | null }, active = false): ThreadModePickerView {
  const view = threadModePicker({ support: enforced, ...read }, active)
  assert.ok(view)
  return view
}

/** The label of the pressed segment, without the sliding indicator markup. */
function selectedLabel(html: string) {
  const button = html.match(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
  return button.replace(/<[^>]+>/g, '').trim()
}

test('the header picker shows three options, the stored mode selected, and the run frozen mode as a badge', () => {
  const html = renderToStaticMarkup(<Picker view={pick({ mode: 'ask', version: 2, frozenMode: 'plan' })} />)
  for (const label of ['计划', '执行', '询问']) assert.ok(html.includes(label), label)
  assert.match(html, /data-slot="thread-mode"/)
  assert.equal(selectedLabel(html), '询问')
  assert.equal(html.match(/aria-pressed=/g)?.length, 3)
  assert.match(html, /data-thread-mode-frozen/)
  assert.match(html, /本次运行：计划/)
  // The picker is the only switch; no notice markup here.
  assert.doesNotMatch(html, /data-slot="thread-mode-notice"/)
})

test('a running thread disables every option and names the reason', () => {
  const html = renderToStaticMarkup(<Picker view={pick({ mode: 'plan', version: 1, frozenMode: 'plan', locked: true })} />)
  assert.match(html, /data-locked/)
  assert.match(html, /aria-label="线程运行中不可切换；结束后选择的模式会在下一轮生效。"/)
  assert.ok((html.match(/disabled=""/g)?.length ?? 0) >= 3)
})

test('an unsupported mode is disabled with its reason, and the stored one offers Execute', () => {
  const support: ThreadModeSupport = { plan: { state: 'unsupported', reason: 'harness' }, execute: { state: 'enforced' }, ask: { state: 'enforced' } }
  const view = pick({ mode: 'plan', version: 2, support })
  const picker = renderToStaticMarkup(<Picker view={view} />)
  assert.match(picker, /aria-label="计划: 此 Agent 无法强制执行当前模式，请改为执行模式。"/)
  const notice = renderToStaticMarkup(<Notice view={view} onSwitchToExecute={() => {}} />)
  assert.match(notice, /此 Agent 无法强制执行当前模式/)
  assert.match(notice, /改为执行/)
})

test('the composer notice says what the stored mode means', () => {
  assert.match(renderToStaticMarkup(<Notice view={pick({ mode: 'plan', version: 0 })} />), /计划模式：本条线程只读并给出方案/)
  assert.match(renderToStaticMarkup(<Notice view={pick({ mode: 'ask', version: 0 })} />), /询问模式：读操作照常/)
  assert.match(renderToStaticMarkup(<Notice view={pick({ mode: 'execute', version: 0 })} />), /执行模式：Agent 可在现有权限内改文件/)
  assert.match(renderToStaticMarkup(<Notice view={pick({ mode: 'ask', version: 0, locked: true })} />), /线程运行中不可切换/)
  assert.equal(renderToStaticMarkup(<Notice view={null} />), '')
})

test('a refused transition is shown in the notice and the selection stays the server value', () => {
  const view = pick({ mode: 'execute', version: 5 })
  const html = renderToStaticMarkup(<Notice view={view} error="threadModeLocked" />)
  assert.match(html, /role="alert"/)
  assert.match(html, /线程正在运行，结束后再切换模式/)
  assert.equal(selectedLabel(renderToStaticMarkup(<Picker view={view} />)), '执行')
})

test('saving disables the picker and marks it busy', () => {
  const html = renderToStaticMarkup(<Picker view={pick({ mode: 'execute', version: 0 })} pending />)
  assert.match(html, /aria-busy="true"/)
  assert.ok((html.match(/disabled=""/g)?.length ?? 0) >= 3)
})
