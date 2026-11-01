import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, cloneElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

let userId: string | null = 'viewer-a'
let pending = false
const translate = (key: string) => key
mock.module(new URL('../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: {
  useSession: () => ({ data: userId ? { user: { id: userId } } : null, isPending: pending }),
  linkSocial: async () => ({ error: true }),
} } })
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useLocale: () => 'en', useFormatter: () => ({}) } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ render, children, disabled, onClick, role }: { render?: ReactElement; children?: React.ReactNode; disabled?: boolean; onClick?: () => void; role?: string }) => render ? cloneElement(render as ReactElement<{ role?: string }>, { role }, children) : <button disabled={disabled} onClick={onClick}>{children}</button> } })

const browser = new Window({ url: 'https://mikka.example/en?settings=integrations' })
const originalFetch = globalThis.fetch
const requests: { resolve: (response: Response) => void }[] = []
let composioRequests = 0
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let GitHubSettings: typeof import('../components/plugins/github-settings')['GitHubSettings']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ GitHubSettings } = await import('../components/plugins/github-settings'))
})

beforeEach(() => {
  userId = 'viewer-a'; pending = false; requests.length = 0; composioRequests = 0
  browser.history.replaceState({}, '', '?settings=integrations')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  globalThis.fetch = input => String(input).endsWith('/github')
    ? new Promise<Response>(resolve => { requests.push({ resolve }) })
    : (composioRequests++, Promise.resolve(Response.json({ configured: false, accounts: [] })))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  globalThis.fetch = originalFetch
})
after(() => { browser.close() })

const render = async () => { await act(async () => { root.render(<GitHubSettings />) }) }
// The mount read starts on SWR's own schedule; wait for that request rather than a fixed delay.
const requested = async (index: number) => {
  for (let waited = 0; !requests[index] && waited < 5_000; waited += 10) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(requests[index], `GitHub request ${index} was made`)
}
const respond = async (index: number, viewerId: string, fullName: string) => {
  await requested(index)
  await act(async () => { requests[index].resolve(Response.json({ viewerId, configured: true, connected: true, installed: true, repositories: [{ id: fullName, fullName }] })) })
}
const respondNotConnected = async (index: number, viewerId: string) => {
  await requested(index)
  await act(async () => { requests[index].resolve(Response.json({ viewerId, configured: true, connected: false, installed: false, repositories: [] })) })
}
// A fresh visit reads GitHub again; focus never does.
// With cached data SWR starts the mount read on the next animation frame.
const frame = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) }) }
const revisit = async () => { await act(async () => { root.unmount() }); root = createRoot(container); await render(); await frame() }
const focus = async () => { await act(async () => {
  browser.dispatchEvent(new browser.Event('focus'))
  browser.document.dispatchEvent(new browser.Event('visibilitychange'))
}) }

test('unconfirmed and signed-out sessions neither request nor display GitHub repositories', async () => {
  pending = true
  await render()
  assert.equal(requests.length, 0)
  assert.equal(composioRequests, 0)
  assert.ok(container.textContent?.includes('githubLoading'))
  pending = false; userId = null
  await render()
  assert.equal(requests.length, 0)
  assert.equal(composioRequests, 0)
  assert.ok(container.textContent?.includes('githubSignInRequired'))
})

test('GitHub installation management is exposed as a link with the exact destination', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  const link = container.querySelector('a[role="link"]')
  assert.ok(link)
  assert.equal(link?.textContent, 'githubManage')
  assert.equal(link?.getAttribute('href'), 'https://github.com/apps/mikka-github/installations/new')
})

test('a switched cookie cannot expose B repositories while the session hook still identifies A', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  assert.ok(container.textContent?.includes('a/private'))
  await revisit()
  await respond(1, 'viewer-b', 'b/private')
  assert.ok(!container.textContent?.includes('a/private'))
  assert.ok(!container.textContent?.includes('b/private'))
  assert.ok(container.textContent?.includes('githubLoadFailed'))
})

test('switching A to B clears A immediately and rejects a late A response', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  await revisit()
  userId = 'viewer-b'
  await render()
  assert.ok(!container.textContent?.includes('a/private'))
  await respond(2, 'viewer-b', 'b/private')
  assert.ok(container.textContent?.includes('b/private'))
  await respond(1, 'viewer-a', 'a/late-private')
  assert.ok(container.textContent?.includes('b/private'))
  assert.ok(!container.textContent?.includes('a/late-private'))
  pending = true
  await render()
  assert.ok(!container.textContent?.includes('b/private'))
  assert.equal(requests.length, 3)
})

test('revoked authorization clears repositories and keeps the relink action available', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  await revisit()
  await requested(1)
  await act(async () => { requests[1].resolve(Response.json({ viewerId: 'viewer-a', error: 'githubReconnectRequired' }, { status: 401 })) })
  assert.ok(!container.textContent?.includes('a/private'))
  assert.ok(container.textContent?.includes('githubReconnectRequired'))
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink' && !button.disabled))
})

test('mismatched and unauthenticated 401 errors cannot offer another viewer a relink action', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  for (const viewerId of ['viewer-b', undefined]) {
    await revisit()
    await act(async () => { requests.at(-1)!.resolve(Response.json({ viewerId, error: 'githubReconnectRequired' }, { status: 401 })) })
    assert.ok(!container.textContent?.includes('a/private'))
    assert.ok(container.textContent?.includes('githubLoadFailed'))
    assert.ok(!container.textContent?.includes('githubReconnectRequired'))
    assert.ok(![...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink'))
  }
})

test('OAuth callback errors survive initial session confirmation and the keyed remount', async () => {
  browser.history.replaceState({}, '', '?settings=integrations&github=link-failed')
  pending = true
  await render()
  assert.equal(new URL(browser.location.href).searchParams.get('github'), 'link-failed')
  pending = false
  await render()
  assert.ok(container.textContent?.includes('githubLinkFailed'))
  assert.equal(new URL(browser.location.href).searchParams.get('github'), null)
})

test('linking goes straight to the GitHub connect route, which redirects to github.com', async () => {
  const assigned: string[] = []
  const location = browser.location as unknown as { assign: (url: string) => void }
  const original = location.assign
  location.assign = url => { assigned.push(url) }
  try {
    userId = 'viewer-link'
    await render()
    await respondNotConnected(0, 'viewer-link')
    const link = [...container.querySelectorAll('button')].find(button => button.textContent === 'githubLink')
    assert.ok(link)
    await act(async () => { link.click() })
    assert.deepEqual(assigned, [`${process.env.MIKKA_BASE_PATH ?? ''}/api/integrations/github/connect`])
    assert.ok(!assigned.some(url => url.includes('settings=')))
  } finally { location.assign = original }
})

test('the desktop shell opens the GitHub connect route in the system browser, not a settings page', async () => {
  const opened: string[] = []
  Object.assign(browser, { mikka: { app: { version: '0.1.1', flavor: 'prod', runtime: 'electron', openExternal: async (url: string) => { opened.push(url) } } } })
  try {
    userId = 'viewer-desktop'
    await render()
    await respondNotConnected(0, 'viewer-desktop')
    const link = [...container.querySelectorAll('button')].find(button => button.textContent === 'githubLink')
    await act(async () => { link!.click() })
    assert.equal(opened.length, 1)
    assert.equal(new URL(opened[0]).pathname, `${process.env.MIKKA_BASE_PATH ?? ''}/api/integrations/github/connect`)
  } finally { delete (browser as unknown as { mikka?: unknown }).mikka }
})

test('focus and visibility never ask GitHub again and never hide what is shown', async () => {
  // Its own viewer: an earlier test leaves viewer-a's read unanswered, which SWR would join.
  userId = 'viewer-focus'
  await render()
  await frame()
  await respond(0, 'viewer-focus', 'focus/private')
  for (let round = 0; round < 3; round++) {
    await focus()
    await frame()
    assert.equal(requests.length, 1)
    assert.ok(container.textContent?.includes('focus/private'))
    assert.ok(!container.textContent?.includes('githubLoading'))
  }
})
