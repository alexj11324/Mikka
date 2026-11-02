import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const workspace = 'f778b9a0-ecec-4ade-97a6-b7aa4221a177'
const opened: string[] = []
let calls = 0, picks = 0, reply: () => Promise<unknown> = async () => ({ queued: true })
class FixtureApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' }, StyleSheet: { create: (value: unknown) => value }, View: ({ children }: { children: ReactNode }) => createElement('div', null, children) } })
mock.module(new URL('../components/cards.tsx', import.meta.url).href, { namedExports: { CardButton: ({ label, disabled, busy, onPress }: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void }) => createElement('button', { disabled: disabled || busy, onClick: onPress }, label) } })
mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text: ({ children }: { children: ReactNode }) => createElement('span', null, children) } })
mock.module(new URL('../lib/home.tsx', import.meta.url).href, { namedExports: { useHome: () => ({ data: { workspace: { id: workspace } } }) } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { api: async () => { calls++; return reply() }, ApiError: FixtureApiError } })
mock.module(new URL('../lib/web.ts', import.meta.url).href, { namedExports: { openOnWeb: async (path: string) => { opened.push(path) }, webChatPath: (bot: string | null) => bot ? `/?section=coordinator&bot=${bot}` : '/?section=coordinator' } })
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: { secondary: 'gray', danger: 'red' } } })
const browser = new Window({ url: 'https://fixture.example/mikka' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let FailedReply: typeof import('../components/FailedReply')['FailedReply']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FailedReply } = await import('../components/FailedReply'))
})
beforeEach(() => { opened.length = 0; calls = 0; picks = 0; reply = async () => ({ queued: true }); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const click = async () => { await act(async () => container.querySelector('button')!.click()) }

test('reconnect recovery opens subscription settings for the phone workspace without retrying', async () => {
  await act(async () => root.render(createElement(FailedReply, { failure: { kind: 'subscription', notice: 'reconnect' }, botId: null, onQueued: () => {} })))
  assert.equal(container.querySelector('button')?.textContent, '模型与订阅')
  await click()
  assert.deepEqual(opened, [`/settings?section=models&workspace=${workspace}`])
  assert.equal(calls, 0)
})

test('a rejected model uses the supplied native model menu directly', async () => {
  await act(async () => root.render(createElement(FailedReply, { failure: { kind: 'subscription', notice: 'modelRejected' }, botId: 'fixture-bot', onQueued: () => {}, modelChoice: createElement('button', { onClick: () => { picks++ } }, 'fixture-native-menu') })))
  assert.match(container.textContent ?? '', /模型请求被拒绝/)
  await click()
  assert.equal(picks, 1)
  assert.equal(calls, 0)
  assert.deepEqual(opened, [])
})

test('retry keeps explicit processing feedback and rejects a burst of duplicate taps', async () => {
  let finish!: (value: unknown) => void
  reply = () => new Promise(resolve => { finish = resolve })
  await act(async () => root.render(createElement(FailedReply, { failure: { kind: 'subscription', notice: 'rateLimited' }, botId: null, onQueued: async () => { throw new Error('fixture-refresh-failure') } })))
  await act(async () => { container.querySelector('button')!.click(); container.querySelector('button')!.click() })
  assert.equal(calls, 1)
  await act(async () => finish({ queued: false, reason: 'working' }))
  assert.match(container.textContent ?? '', /订阅请求受限/)
  assert.match(container.textContent ?? '', /回复正在处理/)
  assert.doesNotMatch(container.textContent ?? '', /fixture-refresh-failure/)
})

test('an explicit HTTP refusal is unavailable while lost transport stays unconfirmed', async () => {
  reply = async () => { throw new FixtureApiError(403, 'fixture-private-provider-text') }
  await act(async () => root.render(createElement(FailedReply, { failure: { kind: 'failed' }, botId: null, onQueued: () => {} })))
  await click()
  assert.match(container.textContent ?? '', /回复暂不可重试/)
  reply = async () => { throw new Error('fixture-private-provider-text') }
  await click()
  assert.match(container.textContent ?? '', /重试未确认/)
  assert.doesNotMatch(container.textContent ?? '', /fixture-private/)
})
