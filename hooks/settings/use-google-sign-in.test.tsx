import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'

let available = false, connected = false, reads = 0, links = 0
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module('@/lib/auth-client', { namedExports: { authClient: {
  listAccounts: async () => { reads++; return available ? { data: connected ? [{ providerId: 'google' }] : [], error: null } : { data: null, error: { message: 'Unavailable' } } },
  linkSocial: async () => { links++; return { data: {}, error: null } },
} } })
mock.module('@/i18n/navigation', { namedExports: { getPathname: () => '/en' } })
mock.module('@/lib/platform/open-settings', { namedExports: { openSettingsInBrowser: async () => 'web' } })
mock.module('@/lib/hooks/use-check-on-return', { namedExports: { useCheckOnReturn: () => () => {} } })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useGoogleSignIn: typeof import('./use-google-sign-in')['useGoogleSignIn']
let GoogleSignInSettings: typeof import('@/components/settings/google-sign-in-settings')['GoogleSignInSettings']
let google: ReturnType<typeof useGoogleSignIn>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useGoogleSignIn } = await import('./use-google-sign-in'))
  ;({ GoogleSignInSettings } = await import('@/components/settings/google-sign-in-settings'))
})
beforeEach(() => {
  available = false; connected = false; reads = 0; links = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe({ enabled }: { enabled: boolean }) { google = useGoogleSignIn(enabled); return null }
async function render(enabled = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe enabled={enabled} /><GoogleSignInSettings googleEnabled={enabled} /></SWRConfig>))
  await settle()
}

test('an unread Google link status stays unknown, blocks linking and can retry the status', async () => {
  await render()
  assert.equal(google.linked, null)
  assert.ok(google.error)
  const link = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Settings.integrations.linkGoogle'))
  assert.equal(link?.disabled, true)
  await act(async () => { await google.link() })
  assert.equal(links, 0)
  available = true; connected = true
  const before = reads
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Common.retry')
  assert.ok(retry)
  await act(async () => retry.click())
  await settle()
  assert.ok(reads > before)
  assert.equal(google.linked, true)
  assert.equal(google.error, '')
  assert.ok(container.textContent?.includes('Settings.integrations.googleLinked'))
})

test('a confirmed unlinked account can start linking', async () => {
  available = true
  await render()
  assert.equal(google.linked, false)
  await act(async () => { await google.link() })
  assert.equal(links, 1)
})

test('a disabled Google integration reads nothing and cannot start linking', async () => {
  await render(false)
  await act(async () => { await google.link() })
  assert.equal(reads, 0)
  assert.equal(links, 0)
})
