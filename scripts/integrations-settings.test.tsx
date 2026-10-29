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
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ render, children, disabled, onClick, role }: { render?: ReactElement; children?: React.ReactNode; disabled?: boolean; onClick?: () => void; role?: string }) => render ? cloneElement(render, { role }, children) : <button disabled={disabled} onClick={onClick}>{children}</button> } })

const browser = new Window({ url: 'https://mikka.example/en?settings=integrations' })
const originalFetch = globalThis.fetch
const requests: { resolve: (response: Response) => void }[] = []
let composioRequests = 0
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let IntegrationsSettings: typeof import('../components/settings/integrations-settings')['IntegrationsSettings']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ IntegrationsSettings } = await import('../components/settings/integrations-settings'))
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

const render = async () => { await act(async () => { root.render(<IntegrationsSettings showWebhookDetails={false} />) }) }
const respond = async (index: number, viewerId: string, fullName: string) => {
  await act(async () => { requests[index].resolve(Response.json({ viewerId, configured: true, connected: true, installed: true, repositories: [{ id: fullName, fullName }] })) })
}
const focus = async () => { await act(async () => { browser.dispatchEvent(new browser.Event('focus')) }) }

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
  assert.ok([...container.querySelectorAll('button')].find(button => button.textContent === 'githubRefresh')?.disabled)
})

test('GitHub installation management is exposed as a link with the exact destination', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  const link = container.querySelector('a[role=\"link\"]')
  assert.ok(link)
  assert.equal(link?.textContent, 'githubManage')
  assert.equal(link?.getAttribute('href'), 'https://github.com/apps/mikka-github/installations/new')
})

test('sign-out does not start another Composio request', async () => {
  await render()
  assert.equal(composioRequests, 1)
  userId = null
  await render()
  assert.equal(composioRequests, 1)
})

test('a switched cookie cannot expose B repositories while the session hook still identifies A', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  assert.ok(container.textContent?.includes('a/private'))
  await focus()
  assert.ok(!container.textContent?.includes('a/private'))
  await respond(1, 'viewer-b', 'b/private')
  assert.ok(!container.textContent?.includes('a/private'))
  assert.ok(!container.textContent?.includes('b/private'))
  assert.ok(container.textContent?.includes('githubLoadFailed'))
})

test('switching A to B clears A immediately and rejects a late A response', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  await focus()
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
  await focus()
  await act(async () => { requests[1].resolve(Response.json({ viewerId: 'viewer-a', error: 'githubReconnectRequired' }, { status: 401 })) })
  assert.ok(!container.textContent?.includes('a/private'))
  assert.ok(container.textContent?.includes('githubReconnectRequired'))
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink' && !button.disabled))
})

test('mismatched and unauthenticated 401 errors cannot offer another viewer a relink action', async () => {
  await render()
  await respond(0, 'viewer-a', 'a/private')
  for (const viewerId of ['viewer-b', undefined]) {
    await focus()
    await act(async () => { requests.at(-1)!.resolve(Response.json({ viewerId, error: 'githubReconnectRequired' }, { status: 401 })) })
    assert.ok(!container.textContent?.includes('a/private'))
    assert.ok(container.textContent?.includes('githubLoadFailed'))
    assert.ok(!container.textContent?.includes('githubReconnectRequired'))
    assert.ok(![...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink'))
  }
})

test('OAuth callback errors survive initial session confirmation and the keyed remount', async () => {
  browser.history.replaceState({}, '', '?settings=integrations&github=link-failed&composio=callback-failed')
  pending = true
  await render()
  assert.equal(new URL(browser.location.href).searchParams.get('github'), 'link-failed')
  assert.equal(new URL(browser.location.href).searchParams.get('composio'), 'callback-failed')
  pending = false
  await render()
  assert.ok(container.textContent?.includes('githubLinkFailed'))
  assert.ok(container.textContent?.includes('callbackVerificationFailed'))
  assert.equal(new URL(browser.location.href).searchParams.get('github'), null)
  assert.equal(new URL(browser.location.href).searchParams.get('composio'), null)
})
