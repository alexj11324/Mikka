import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from 'next-intl'
import en from '../messages/en.json'
import zh from '../messages/zh-CN.json'
import type { CoordinatorLiveReply } from '../lib/coordinator-stream-client'

// The wait before a reply's words: affectUI's Thinking Loader, its label from the stream's events, a check on the first word.
const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
let wait: typeof import('../components/coordinator/reply-wait')
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  wait = await import('../components/coordinator/reply-wait')
})
after(() => browser.happyDOM.close())

async function mount(locale: 'en' | 'zh-CN' = 'en') {
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const render = (children: ReactNode) => act(async () => { root.render(<NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'en' ? en : zh}>{children}</NextIntlClientProvider>) })
  return { container, render, unmount: () => act(async () => root.unmount()) }
}

const reply = (fields: Partial<CoordinatorLiveReply> = {}): CoordinatorLiveReply => ({ id: 'run:1', text: '', ...fields })

test('the wait follows real events: sent, a tool running, its result, the first word', () => {
  const { replyWait } = wait
  assert.equal(replyWait(false, []), null, 'nothing while the chat is not working')
  assert.equal(replyWait(false, [reply({ tools: [{ call: 'c1', name: 'web_search', state: 'running' }] })]), null)
  assert.deepEqual(replyWait(true, []), { phase: 'thinking' }, 'a sent message waits on thinking')
  assert.deepEqual(replyWait(true, [reply({ thinking: { ms: 0, since: 1 } })]), { phase: 'thinking' })
  assert.deepEqual(replyWait(true, [reply({ tools: [{ call: 'c1', name: 'web_search', state: 'running' }] })]), { phase: 'tool', tool: 'web_search' })
  assert.deepEqual(replyWait(true, [reply({ tools: [{ call: 'c1', name: 'web_search', state: 'done' }, { call: 'c2', name: 'list_issues', state: 'running' }] })]), { phase: 'tool', tool: 'list_issues' }, 'the tool running now')
  assert.deepEqual(replyWait(true, [reply({ tools: [{ call: 'c1', name: 'web_search', state: 'done' }] })]), { phase: 'reading' })
  assert.deepEqual(replyWait(true, [reply({ tools: [{ call: 'c1', name: 'web_search', state: 'error' }] })]), { phase: 'reading' })
  assert.deepEqual(replyWait(true, [reply({ text: 'H', tools: [{ call: 'c1', name: 'web_search', state: 'done' }] })]), { phase: 'answering' })
  assert.deepEqual(replyWait(true, [reply({ text: 'Done.' }), reply({ id: 'run:2', tools: [{ call: 'c3', name: 'dispatch_run', state: 'running' }] })]), { phase: 'tool', tool: 'dispatch_run' }, 'a later step waits again')
  assert.deepEqual(replyWait(true, [], true), { phase: 'answering' }, 'a stored reply is not waited on again')
})

test('the loader walks its phases from the events, checks on the first word, then leaves', async () => {
  const { ReplyWaitLine, DONE_HOLD_MS } = wait
  const view = await mount()
  const line = () => view.container.querySelector('[data-reply-wait]')
  const status = () => view.container.querySelector('[role="status"]')
  const label = () => status()?.querySelector('.ui-tlc__label:not(.ui-tlc__label--out)')?.textContent
  try {
    await view.render(<ReplyWaitLine wait={null} />)
    assert.equal(view.container.innerHTML, '')

    await view.render(<ReplyWaitLine wait={{ phase: 'thinking' }} />)
    assert.equal(line()?.getAttribute('data-reply-wait'), 'thinking')
    assert.ok(status()?.classList.contains('ui-tlc'), 'affectUI Thinking Loader')
    assert.equal(status()?.getAttribute('aria-live'), 'polite')
    assert.equal(status()?.hasAttribute('data-done'), false)
    assert.equal(label(), 'Thinking')

    await view.render(<ReplyWaitLine wait={{ phase: 'tool', tool: 'web_search' }} />)
    assert.equal(line()?.getAttribute('data-reply-wait'), 'tool')
    assert.equal(label(), 'Search the web', 'the running tool by its label')
    await view.render(<ReplyWaitLine wait={{ phase: 'tool', tool: 'some_internal_tool' }} />)
    assert.equal(label(), 'Use a tool', 'an internal tool name never shows')

    await view.render(<ReplyWaitLine wait={{ phase: 'reading' }} />)
    assert.equal(label(), 'Reading results')

    await view.render(<ReplyWaitLine wait={{ phase: 'answering' }} />)
    assert.equal(line()?.getAttribute('data-reply-wait'), 'done')
    assert.equal(status()?.hasAttribute('data-done'), true, 'the spinner turns into a check')
    assert.match(label() ?? '', /^Thought for \d+ seconds?$/)

    await act(() => new Promise(resolve => setTimeout(resolve, DONE_HOLD_MS + 50)))
    assert.equal(view.container.innerHTML, '', 'the reply alone remains')

    await view.render(<ReplyWaitLine wait={{ phase: 'answering' }} />)
    assert.equal(view.container.innerHTML, '', 'words still arriving bring no loader back')
    await view.render(<ReplyWaitLine wait={{ phase: 'tool', tool: 'dispatch_run' }} />)
    assert.equal(status()?.hasAttribute('data-done'), false, 'a later step waits again')
    assert.equal(label(), 'Start thread')
    await view.render(<ReplyWaitLine wait={null} />)
    assert.equal(view.container.innerHTML, '', 'a turn that ends without words leaves at once')
  } finally { await view.unmount() }
})

test('the loader speaks the interface language, in short labels', async () => {
  const { ReplyWaitLine } = wait
  const view = await mount('zh-CN')
  const label = () => view.container.querySelector('.ui-tlc__label:not(.ui-tlc__label--out)')?.textContent
  try {
    await view.render(<ReplyWaitLine wait={{ phase: 'thinking' }} />)
    assert.equal(label(), '思考中')
    await view.render(<ReplyWaitLine wait={{ phase: 'tool', tool: 'web_search' }} />)
    assert.equal(label(), '搜索网页')
    await view.render(<ReplyWaitLine wait={{ phase: 'reading' }} />)
    assert.equal(label(), '阅读结果')
    for (const text of [zh.Coordinator.activity.thinking, zh.Coordinator.activity.reading, zh.Coordinator.activity.tool]) assert.ok(text.length >= 2 && text.length <= 4, text)
    await view.render(<ReplyWaitLine wait={{ phase: 'answering' }} />)
    assert.match(label() ?? '', /^思考了 \d+ 秒$/)
  } finally { await view.unmount() }
})
