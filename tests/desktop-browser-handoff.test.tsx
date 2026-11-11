import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import { Window } from 'happy-dom'

// The browser half of a desktop sign-in (components/auth-form.tsx): the app
// already chose a provider, so the page starts it; a web session in this
// browser is shown before the app gets it, and 换个账号 asks for the picker.
const origin = 'https://app.example'
const state = 'abcdefghijklmnop1234'
const callback = 'http://127.0.0.1:49152/auth/callback'
const desktopFlow = { state, next: '/', callback }
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
type SocialCall = { provider: string; callbackURL: string; additionalParams?: Record<string, string> }
const socialCalls: SocialCall[] = []
stub('../lib/auth-client.ts', { authClient: { signIn: { social: async (options: SocialCall) => { socialCalls.push(options); return { data: { url: `https://accounts.example/${options.provider}` } } } } } })
stub('../app/actions/issues.ts', { listIssues: async () => [], saveIssue: async () => ({}) })
stub('../components/auth/turnstile.tsx', { Turnstile: () => null })
stub('../components/blocks/auth-19/components/auth.tsx', { Auth: ({ children }: { children: ReactNode }) => children })
stub('../i18n/navigation.ts', { getPathname: ({ href, locale }: { href: string; locale: string }) => `/${locale}${href === '/' ? '' : href}`, Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> })

const browser = new Window({ url: `${origin}/mikka/en/sign-in` })
const assigned: string[] = []
let createRoot: typeof import('react-dom/client')['createRoot']
let AuthForm: typeof import('../components/auth-form')['AuthForm']
let IntlProvider: typeof import('next-intl')['NextIntlClientProvider']
let messages: Record<string, unknown>
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, history: browser.history, sessionStorage: browser.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.defineProperty(browser.location, 'assign', { configurable: true, value: (url: string) => { assigned.push(url) } })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AuthForm } = await import('../components/auth-form'))
  ;({ NextIntlClientProvider: IntlProvider } = await import('next-intl'))
  messages = (await import('../messages/en.json')).default
})
after(() => browser.close())
beforeEach(() => { socialCalls.length = 0; assigned.length = 0 })

async function render(query: Record<string, string>, props: Partial<Parameters<typeof AuthForm>[0]>, handoff: typeof desktopFlow | null = desktopFlow) {
  browser.history.replaceState({}, '', `/mikka/en/sign-in?${new URLSearchParams({ ...(handoff && { desktop: '1', desktop_state: handoff.state, desktop_next: '/', desktop_callback: callback }), ...query })}`)
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<IntlProvider locale="en" timeZone="UTC" messages={messages}>
      <AuthForm mode="sign-in" googleEnabled githubEnabled emailEnabled={false} desktopFlow={handoff} {...props} />
    </IntlProvider>)
  })
  return { container, unmount: () => act(() => root.unmount()) }
}

test('the provider the app asked for starts without another click, and Back does not start it again', async () => {
  const first = { ...desktopFlow, state: 'first-handoff-state-0001' }
  const { unmount } = await render({ continue: 'google' }, { continueGoogle: true }, first)
  try {
    assert.equal(socialCalls.length, 1)
    assert.equal(socialCalls[0].provider, 'google')
    const returned = new URL(socialCalls[0].callbackURL)
    assert.equal(returned.pathname.endsWith('/api/desktop/return'), true)
    assert.equal(returned.searchParams.get('state'), first.state)
    assert.equal(socialCalls[0].additionalParams, undefined)
    assert.deepEqual(assigned, ['https://accounts.example/google'])
  } finally { await unmount() }
  // Back from Google lands on the same handoff: the card, not another redirect.
  socialCalls.length = 0
  const back = await render({ continue: 'google' }, { continueGoogle: true }, first)
  try {
    assert.equal(socialCalls.length, 0)
    assert.match(back.container.textContent ?? '', /Continue with Google/)
  } finally { await back.unmount() }
  const github = await render({ continue: 'github' }, { continueGitHub: true }, { ...desktopFlow, state: 'second-handoff-state-002' })
  try { assert.deepEqual(socialCalls.map(call => call.provider), ['github']) } finally { await github.unmount() }
})

test('a failed attempt shows the card instead of starting again', async () => {
  const { container, unmount } = await render({ continue: 'google', oauth: 'failed' }, { continueGoogle: true, oauthFailed: true })
  try {
    assert.equal(socialCalls.length, 0)
    assert.match(container.textContent ?? '', /Continue with Google/)
  } finally { await unmount() }
})

test('a web session is shown before the app gets it; another account opens the provider picker', async () => {
  const signedInAs = { name: 'Alex', email: 'alex@example.com', image: null }
  const { container, unmount } = await render({ continue: 'google' }, { continueGoogle: true, signedInAs })
  try {
    assert.equal(socialCalls.length, 0)
    assert.match(container.textContent ?? '', /alex@example\.com/)
    const proceed = container.querySelector('[data-testid="desktop-continue"]') as HTMLAnchorElement
    assert.equal(proceed.textContent, 'Continue as Alex')
    const href = new URL(proceed.getAttribute('href')!, origin)
    assert.equal(href.pathname.endsWith('/api/desktop/return'), true)
    assert.equal(href.searchParams.get('state'), state)
    assert.equal(href.searchParams.get('callback'), callback)
    const other = container.querySelector('[data-testid="desktop-switch-account"]') as HTMLButtonElement
    assert.equal(other.textContent, 'Use another account')
    await act(async () => { other.click() })
    assert.equal(socialCalls.length, 1)
    assert.equal(socialCalls[0].provider, 'google')
    assert.deepEqual(socialCalls[0].additionalParams, { prompt: 'select_account' })
  } finally { await unmount() }
})

test('without a provider, another account opens the ordinary sign-in card with the picker on', async () => {
  const signedInAs = { name: '', email: 'alex@example.com', image: null }
  const { container, unmount } = await render({}, { signedInAs })
  try {
    const proceed = container.querySelector('[data-testid="desktop-continue"]') as HTMLAnchorElement
    assert.equal(proceed.textContent, 'Continue as alex@example.com')
    await act(async () => { (container.querySelector('[data-testid="desktop-switch-account"]') as HTMLButtonElement).click() })
    assert.equal(container.querySelector('[data-testid="desktop-continue"]'), null)
    const google = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Continue with Google')) as HTMLButtonElement
    await act(async () => { google.click() })
    assert.deepEqual(socialCalls.map(call => [call.provider, call.additionalParams]), [['google', { prompt: 'select_account' }]])
  } finally { await unmount() }
})


test('expired self-host sign-in names the saved installation and never presents the Cloud credential form', async () => {
  const url = 'https://self.example/mikka'
  const server = { url, name: 'Personal Server', version: 'v1', edition: 'community', signIn: { email: true, google: false, github: false } }
  browser.localStorage.setItem('mikka.web.servers.v1', JSON.stringify({ version: 1, servers: [server] }))
  browser.sessionStorage.setItem('mikka.web.sessions.v1', JSON.stringify({ version: 1, credentials: [], active: null, expiredServer: url }))
  const { installWebServerTransport } = await import('../lib/web-connection/browser')
  installWebServerTransport(browser as unknown as globalThis.Window)
  const { container, unmount } = await render({}, { mode: 'sign-in', googleEnabled: true }, null)
  try {
    assert.match(container.textContent ?? '', /Personal Server/)
    assert.match(container.textContent ?? '', /Session expired/)
    assert.ok([...container.querySelectorAll('button')].some(button => button.textContent === 'Sign in'))
    assert.equal(container.querySelector('input[name="password"]'), null)
    assert.equal(socialCalls.length, 0)
  } finally { await unmount() }
})
