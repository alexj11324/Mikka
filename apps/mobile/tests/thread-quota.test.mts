import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const RUN = '21111111-1111-4111-8111-111111111111'
const WORKSPACE = '31111111-1111-4111-8111-111111111111'
const calls: { path: string; body: unknown }[] = [], opened: string[] = []
let next: () => Promise<unknown> = async () => ({ runId: RUN }), continued = ''
class FixtureApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
mock.module('react-native', { namedExports: { StyleSheet: { create: (value: unknown) => value }, View: ({ children }: { children: ReactNode }) => createElement('div', null, children) } })
mock.module(new URL('../components/cards.tsx', import.meta.url).href, { namedExports: {
  ChatCard: ({ children }: { children: ReactNode }) => createElement('article', null, children), cardText: {},
  CardButton: ({ label, disabled, busy, onPress }: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void }) => createElement('button', { disabled: disabled || busy, onClick: onPress }, label),
} })
mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text: ({ children }: { children: ReactNode }) => createElement('span', null, children) } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { ApiError: FixtureApiError, api: async (path: string, options: { body: unknown }) => { calls.push({ path, body: options.body }); return next() } } })
mock.module(new URL('../lib/home.tsx', import.meta.url).href, { namedExports: { useHome: () => ({ data: { workspace: { id: WORKSPACE } } }) } })
mock.module(new URL('../lib/web.ts', import.meta.url).href, { namedExports: { openOnWeb: async (path: string) => { opened.push(path) } } })
const browser = new Window({ url: 'https://fixture.example/mikka' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadQuotaPaused: typeof import('../components/ThreadQuotaPaused')['ThreadQuotaPaused']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadQuotaPaused } = await import('../components/ThreadQuotaPaused'))
})
beforeEach(() => { calls.length = 0; opened.length = 0; continued = ''; next = async () => ({ runId: RUN }); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (keyReady = true, resetsAt: string | null = null) => { await act(async () => root.render(createElement(ThreadQuotaPaused, { paused: { runId: RUN, subscription: 'claude', plan: 'Max', resetsAt, keyReady }, onContinued: (runId: string) => { continued = runId } }))) }
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label)!

test('quota recovery names cost and never starts a paid continuation until the key button is tapped', async () => {
  await render(true, new Date(Date.now() + 60_000).toISOString())
  assert.match(container.textContent ?? '', /Claude Max.*额度已用完/)
  assert.match(container.textContent ?? '', /按 token 计费/)
  assert.equal(calls.length, 0)
  assert.equal(button('重置后重试').disabled, true)
  await act(async () => button('用 API Key 继续').click())
  assert.deepEqual(calls, [{ path: `/api/mobile/threads/${RUN}/continue`, body: { via: 'key' } }])
  assert.equal(continued, RUN)
})

test('after reset the original subscription can retry; no key opens the exact workspace settings', async () => {
  await render(false, new Date(Date.now() - 1_000).toISOString())
  await act(async () => button('添加 API Key 继续').click())
  assert.deepEqual(opened, [`/settings?section=models&workspace=${WORKSPACE}`])
  assert.equal(calls.length, 0)
  await act(async () => button('重置后重试').click())
  assert.equal((calls[0].body as { via: string }).via, 'retry')
})

test('duplicate taps stay one request and a lost response reports unconfirmed without provider text', async () => {
  let reject!: (error: unknown) => void
  next = () => new Promise((_resolve, fail) => { reject = fail })
  await render()
  await act(async () => { button('用 API Key 继续').click(); button('用 API Key 继续').click() })
  assert.equal(calls.length, 1)
  await act(async () => reject(new Error('fixture-private-provider-text')))
  assert.match(container.textContent ?? '', /继续未确认/)
  assert.doesNotMatch(container.textContent ?? '', /fixture-private/)
  assert.equal(continued, '')
})
