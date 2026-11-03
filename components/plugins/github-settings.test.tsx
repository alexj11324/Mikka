import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// Plugins → GitHub from the desktop app (2026-11-03): the link runs in the system
// browser, so the page re-reads on each return until it is linked, and says when
// the browser is signed in as another account than the app.
const t = (key: string, args?: Record<string, string>) => args ? `${key} ${JSON.stringify(args)}` : key
mock.module('next-intl', { namedExports: { useTranslations: () => t } })
mock.module('sonner', { namedExports: { toast: { success: () => undefined } } })
const signOut = mock.fn(async () => undefined)
mock.module('@/lib/auth-client', { namedExports: { authClient: { useSession: () => ({ data: { user: { id: 'app-user', email: 'alex@acme.test' } }, isPending: false }), signOut } } })
mock.module(new URL('./connected-apps.tsx', import.meta.url).href, { namedExports: {
  AppTile: () => null, ToolGroup: ({ title }: { title: string; children?: ReactNode }) => <p>{title}</p>,
} })

const TOKEN = `ghi_${'a'.repeat(43)}`
let github: { connected: boolean } = { connected: false }
let intent: unknown = { state: 'waiting', browserAccount: null }
const requests: string[] = []
const browser = new Window({ url: 'https://mikka.test/?section=plugins&app=github' })
const assigned: string[] = []
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let GitHubSettings: typeof import('./github-settings')['GitHubSettings']
let SWRConfig: typeof import('swr')['SWRConfig']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.defineProperty(browser.location, 'assign', { configurable: true, value: (url: string) => { assigned.push(url) } })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}`)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('/connect/intent') && init?.method === 'POST') return json({ token: TOKEN, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (url.includes('/connect/intent')) return json(intent)
    return json({ viewerId: 'app-user', configured: true, connected: github.connected, login: github.connected ? 'octo' : null, installed: false, repositories: [] })
  }) as typeof fetch
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ GitHubSettings } = await import('./github-settings'))
})
beforeEach(() => {
  github = { connected: false }; intent = { state: 'waiting', browserAccount: null }
  requests.length = 0; assigned.length = 0; signOut.mock.resetCalls()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); delete (browser as unknown as { mikka?: unknown }).mikka })
after(() => { browser.close() })

const settle = async (ms = 30) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async () => { await act(async () => { root.render(<SWRConfig value={{ provider: () => new Map() }}><GitHubSettings /></SWRConfig>) }); await settle() }
const comeBack = async () => {
  await act(async () => { browser.dispatchEvent(new browser.Event('focus')); browser.document.dispatchEvent(new browser.Event('visibilitychange')) })
  await settle()
}
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

test('from the desktop: the browser gets a one-time token, every return re-reads, and a link shows at once', async () => {
  const opened: string[] = []
  Object.assign(browser, { mikka: { app: { runtime: 'electron', openExternal: async (url: string) => { opened.push(url) } } } })
  await render()
  // Plain focus before any link reads nothing.
  requests.length = 0
  await comeBack()
  assert.deepEqual(requests, [])
  await act(async () => { button('githubLink')!.click() })
  await settle()
  assert.equal(opened.length, 1)
  assert.equal(new URL(opened[0]).searchParams.get('intent'), TOKEN)
  assert.ok(container.textContent?.includes('githubLinkWaiting'))
  // Back before finishing in the browser: still linking, and the next return reads again.
  requests.length = 0
  await comeBack()
  assert.ok((requests as string[]).some(request => request.endsWith('/api/integrations/github')), 're-read the GitHub status')
  assert.ok(button('githubLink'), 'not linked yet')
  // The browser was signed in as another account: the app says which two.
  intent = { state: 'waiting', browserAccount: 'other@example.test' }
  await settle(1100)
  await comeBack()
  assert.ok(container.textContent?.includes(`githubLinkOtherAccount ${JSON.stringify({ browser: 'other@example.test', app: 'alex@acme.test' })}`))
  assert.ok(button('githubOpenBrowser'))
  // Linked in the browser: the next return shows it, with no refresh button.
  github = { connected: true }
  await settle(1100)
  await comeBack()
  assert.equal(button('githubLink'), undefined)
  assert.ok(container.textContent?.includes('githubDisconnect'))
  assert.ok(!container.textContent?.includes('githubLinkWaiting'))
  assert.ok(!container.textContent?.includes('githubLinkOtherAccount'))
  // Done: returns read nothing more.
  requests.length = 0
  await settle(1100)
  await comeBack()
  assert.deepEqual(requests, [])
})

test('in the browser signed in as another account: both accounts are named and the switch keeps the same link', async () => {
  browser.history.replaceState({}, '', `/?section=plugins&app=github&github=link-failed&reason=browser-account&intent=${TOKEN}`)
  intent = { state: 'otherAccount', browserAccount: 'other@example.test', appAccount: 'al•••@acme.test' }
  await render()
  assert.ok(container.textContent?.includes(`githubLinkOtherAccount ${JSON.stringify({ browser: 'other@example.test', app: 'al•••@acme.test' })}`))
  assert.ok(!container.textContent?.includes('githubLinkFailed'), 'the two accounts are the message')
  assert.equal(button('githubLink'), undefined, 'the page\'s own link would link this browser\'s account')
  assert.equal(browser.location.search, '?section=plugins&app=github', 'the token leaves the address')
  await act(async () => { button('githubSwitchAccount')!.click() })
  await settle()
  assert.equal(signOut.mock.callCount(), 1)
  const next = new URL(assigned[0], 'https://mikka.test').searchParams.get('next')
  assert.equal(next, `/?section=plugins&app=github&intent=${TOKEN}`)
})

test('in the browser signed in as the app\'s account: the same link goes on', async () => {
  browser.history.replaceState({}, '', `/?section=plugins&app=github&intent=${TOKEN}`)
  intent = { state: 'waiting', browserAccount: 'other@example.test' }
  await render()
  await act(async () => { button('githubContinueLink')!.click() })
  assert.equal(new URL(assigned[0], 'https://mikka.test').searchParams.get('intent'), TOKEN)
})

test('an expired link says so', async () => {
  browser.history.replaceState({}, '', `/?section=plugins&app=github&github=link-failed&reason=expired`)
  await render()
  assert.ok(container.textContent?.includes('githubLinkExpired'))
})
