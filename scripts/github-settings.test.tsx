import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, cloneElement, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

let userId: string | null = 'viewer-a'
let pending = false
// Values are shown too, so a test can tell whose @login (or which count) is on screen.
const translate = (key: string, values?: Record<string, unknown>) => values ? `${key}(${Object.values(values).join(',')})` : key
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
// Plugins › GitHub's write settings, as the permissions route answers them.
let permissions: Record<string, unknown> | null = null
const patches: unknown[] = []
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let GitHubSettings: typeof import('../components/plugins/github-settings')['GitHubSettings']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  // The page's collapsible tool groups and account menu need these DOM globals.
  for (const key of ['HTMLElement', 'Node', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ GitHubSettings } = await import('../components/plugins/github-settings'))
})

beforeEach(() => {
  userId = 'viewer-a'; pending = false; requests.length = 0; composioRequests = 0; patches.length = 0
  permissions = null
  browser.history.replaceState({}, '', '?settings=integrations')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  globalThis.fetch = (input, init) => String(input).endsWith('/github')
    ? new Promise<Response>(resolve => { requests.push({ resolve }) })
    : String(input).endsWith('/github/permissions')
      ? init?.method === 'PATCH'
        ? (patches.push(JSON.parse(String(init.body))), Promise.resolve(Response.json({ ...permissions, ...JSON.parse(String(init.body)), version: '1:1' })))
        : Promise.resolve(permissions ? Response.json(permissions) : Response.json({ error: 'authRequired' }, { status: 401 }))
      : (composioRequests++, Promise.resolve(Response.json({ configured: false, accounts: [] })))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  globalThis.fetch = originalFetch
})
after(() => { browser.close() })

const render = async () => { await act(async () => { root.render(<GitHubSettings />) }) }
const respond = async (index: number, viewerId: string, fullName: string) => {
  // The card names the account, never the repositories: the login carries the name the tests look for.
  await act(async () => { requests[index].resolve(Response.json({ viewerId, configured: true, connected: true, login: fullName, installed: true, repositories: [{ id: fullName, fullName, htmlUrl: `https://github.com/${fullName}`, private: true }] })) })
}
const respondNotConnected = async (index: number, viewerId: string) => {
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

test('the page lists what Agents can do, split into write and read, connected or not', async () => {
  userId = 'viewer-tools'
  await render()
  await respondNotConnected(0, 'viewer-tools')
  const text = container.textContent ?? ''
  assert.ok(text.includes('githubDescription'))
  for (const tool of ['githubTool.push', 'githubTool.pullRequest', 'githubTool.readCode', 'githubTool.readPullRequest', 'githubTool.readIssue', 'githubTool.readChecks']) assert.ok(text.includes(tool), tool)
  assert.ok(text.includes('writeTools(2)') && text.includes('readTools(4)'))
  assert.ok(text.includes('githubAbilitiesSummary(6,2,4)'))
  assert.ok(!text.includes('githubRepositoryAccess') && !text.includes('githubConnectionHeading'))
  assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink'))
})

test('a connected page shows the account and a repository count; the names open in their own dialog', async () => {
  userId = 'viewer-connected'
  await render()
  await act(async () => { requests[0].resolve(Response.json({ viewerId: 'viewer-connected', configured: true, connected: true, login: 'octo', installed: true, repositories: [
    { id: '1', fullName: 'octo/private', installationId: '9', htmlUrl: 'https://github.com/octo/private', private: true },
    { id: '2', fullName: 'octo/site', installationId: '9', htmlUrl: 'https://github.com/octo/site', private: false },
  ] })) })
  const text = container.textContent ?? ''
  assert.ok(text.includes('githubConnectionHeading') && text.includes('githubLogin(octo)'))
  assert.ok(text.includes('githubRepositoryAccess') && text.includes('githubRepositories(2)'))
  assert.ok(!text.includes('octo/private') && !text.includes('octo/site'), 'the card never lists repositories')
  assert.ok(![...container.querySelectorAll('button')].some(button => button.textContent === 'githubLink'))
  const row = [...container.querySelectorAll('button')].find(button => button.textContent === 'githubRepositories(2)')
  assert.ok(row)
  await act(async () => { row.click() })
  await frame()
  const dialog = document.body.querySelector('[role="dialog"]')
  assert.ok(dialog?.textContent?.includes('githubRepositoriesDialog'))
  assert.equal(dialog?.querySelector('a[href="https://github.com/octo/private"]')?.textContent, 'octo/privategithubPrivate')
  assert.equal(dialog?.querySelector('a[href="https://github.com/octo/site"]')?.textContent, 'octo/site')
  const search = dialog?.querySelector('input') as HTMLInputElement | null
  assert.ok(search)
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!
    setValue.call(search, 'SITE')
    search.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
  assert.ok(!dialog?.querySelector('a[href="https://github.com/octo/private"]'))
  assert.ok(dialog?.querySelector('a[href="https://github.com/octo/site"]'))
})

test('only the two writes carry a control; push offers allow / deny and shows a stored ask as allow', async () => {
  userId = 'viewer-permissions'
  permissions = { viewerId: 'viewer-permissions', push: 'ask', pullRequest: 'allow', version: '3:4' }
  await render()
  await respondNotConnected(0, 'viewer-permissions')
  await frame()
  const groups = [...container.querySelectorAll('[role="group"]')]
  assert.deepEqual(groups.map(group => group.getAttribute('aria-label')), ['githubTool.push', 'githubTool.pullRequest'])
  const pressed = (group: Element) => [...group.querySelectorAll('button')].filter(button => button.getAttribute('aria-pressed') === 'true' || button.hasAttribute('data-pressed')).map(button => button.textContent)
  const options = (group: Element) => [...group.querySelectorAll('button')].map(button => button.textContent)
  assert.deepEqual(options(groups[0]), ['githubPermission.allow', 'githubPermission.deny'])
  assert.deepEqual(options(groups[1]), ['githubPermission.allow', 'githubPermission.ask', 'githubPermission.deny'])
  assert.deepEqual(pressed(groups[0]), ['githubPermission.allow'])
  assert.deepEqual(pressed(groups[1]), ['githubPermission.allow'])
  const deny = [...groups[1].querySelectorAll('button')].find(button => button.textContent === 'githubPermission.deny')!
  await act(async () => { deny.click() })
  await frame()
  assert.deepEqual(patches, [{ version: '3:4', pullRequest: 'deny' }])
  assert.deepEqual(pressed(container.querySelectorAll('[role="group"]')[1]), ['githubPermission.deny'])
})

test('settings answered for another viewer are never shown or saved', async () => {
  userId = 'viewer-own'
  permissions = { viewerId: 'viewer-other', push: 'allow', pullRequest: 'allow', version: '1:1' }
  await render()
  await respondNotConnected(0, 'viewer-own')
  await frame()
  for (const group of container.querySelectorAll('[role="group"]')) {
    assert.ok([...group.querySelectorAll('button')].every(button => button.disabled || button.hasAttribute('data-disabled')))
    assert.ok(![...group.querySelectorAll('button')].some(button => button.getAttribute('aria-pressed') === 'true'))
  }
  assert.equal(patches.length, 0)
})

test('a failed link shows one alert under the header', async () => {
  browser.history.replaceState({}, '', '?settings=integrations&github=link-failed')
  userId = 'viewer-failed'
  await render()
  await respondNotConnected(0, 'viewer-failed')
  const alerts = [...container.querySelectorAll('[role="alert"]')]
  assert.deepEqual(alerts.map(alert => alert.textContent), ['githubLinkFailed'])
})
