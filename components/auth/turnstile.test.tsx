import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, useEffect, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import { NextIntlClientProvider } from '@/lib/intl/i18n-client'
import messages from '../../messages/en.json'

mock.module('@/lib/client-runtime/script', { defaultExport: function Script({ src, onReady }: { src: string; onReady: () => void }) {
  useEffect(() => { onReady() }, [onReady])
  return <script data-src={src} />
} })
mock.module('@/app/actions/issues', { namedExports: { listIssues: async () => [], saveIssue: async () => ({}) } })
mock.module('@/components/blocks/auth-19/components/auth', { namedExports: { Auth: ({ children }: { children: ReactNode }) => children } })
mock.module('@/components/settings/web-server-control', { namedExports: { WebServerControl: () => null } })
mock.module('@/i18n/navigation', { namedExports: {
  getPathname: ({ href }: { href: string }) => href,
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
} })

type SignupRequest = { name: string; email: string; password: string; fetchOptions: { headers: Record<string, string> } }
const requests: SignupRequest[] = []
let refuseNext = true
mock.module('@/lib/auth-client', { namedExports: { authClient: {
  signUp: { email: async (credentials: SignupRequest) => {
    requests.push(credentials)
    if (refuseNext) { refuseNext = false; return { error: { status: 400, code: 'TURNSTILE_INVALID' } } }
    return { error: null }
  } },
  getSession: async () => ({ data: { user: { id: 'new-user' } } }),
} } })

function translated(children: ReactNode) {
  return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{children}</NextIntlClientProvider>
}

let Turnstile: typeof import('./turnstile')['Turnstile']
before(async () => { ({ Turnstile } = await import('./turnstile')) })

test('renders the Cloudflare widget when a site key is set', () => {
  const html = renderToStaticMarkup(translated(<Turnstile siteKey="1x00000000000000000000AA" onToken={() => {}} />))
  assert.match(html, /data-slot="turnstile"/)
  assert.match(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/)
})

test('renders nothing without a site key (local, previews)', () => {
  assert.equal(renderToStaticMarkup(translated(<Turnstile siteKey="" onToken={() => {}} />)), '')
})

const browser = new Window({ url: 'https://app.example/mikka/en/sign-up' })
after(() => browser.close())

test('signup blocks missing/expired tokens and recovers from refusal with retained fields and fresh verification', async () => {
  const originalSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '1x00000000000000000000AA'
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, history: browser.history, sessionStorage: browser.sessionStorage, FormData: browser.FormData, IS_REACT_ACT_ENVIRONMENT: true, Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, ShadowRoot: browser.ShadowRoot, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  type Callbacks = { callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }
  let callbacks: Callbacks | undefined
  let resets = 0
  const navigations: string[] = []
  Object.defineProperty(browser.location, 'replace', { configurable: true, value: (url: string) => { navigations.push(url) } })
  Object.assign(browser, { turnstile: {
    render: (_container: HTMLElement, options: Callbacks) => { callbacks = options; return 'widget' },
    reset: () => { resets++ },
    remove: () => {},
  } })
  const { createRoot } = await import('react-dom/client')
  const { AuthForm } = await import('../auth-form')
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  const dispatchSubmit = () => container.querySelector('form')!.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
  try {
    await act(async () => root.render(translated(<AuthForm mode="sign-up" />)))
    const values = { name: 'Test User', email: 'signup@example.com', password: 'typed-password' }
    for (const [name, value] of Object.entries(values)) (container.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    assert.equal(submit.disabled, true, 'submit waits for the widget token')
    await act(async () => { dispatchSubmit() })
    assert.equal(requests.length, 0, 'Enter/programmatic submission cannot bypass verification')
    assert.ok(callbacks, 'the real widget wrapper registers callbacks')
    const widgetCallbacks = callbacks
    await act(async () => { widgetCallbacks.callback('expired-token') })
    assert.equal(submit.disabled, false)
    await act(async () => {
      widgetCallbacks['expired-callback']()
      dispatchSubmit()
    })
    assert.equal(requests.length, 0, 'expiration invalidates the token before another render')
    assert.equal(submit.disabled, true)
    await act(async () => { widgetCallbacks.callback('first-token') })
    await act(async () => { dispatchSubmit() })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].fetchOptions.headers['x-turnstile-token'], 'first-token')
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /Human verification failed/)
    for (const [name, value] of Object.entries(values)) assert.equal((container.querySelector(`[name="${name}"]`) as HTMLInputElement).value, value)
    assert.equal(resets, 1, 'a refused request resets the widget')
    assert.equal(submit.disabled, true)
    await act(async () => { dispatchSubmit() })
    assert.equal(requests.length, 1, 'the consumed token cannot be submitted again')
    const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry verification')
    assert.ok(retry)
    assert.equal(retry.type, 'button')
    await act(async () => { retry.click() })
    assert.equal(resets, 2)
    assert.equal(submit.disabled, true)
    await act(async () => { widgetCallbacks.callback('fresh-token') })
    assert.equal(submit.disabled, false)
    await act(async () => { dispatchSubmit() })
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1], { ...values, fetchOptions: { headers: { 'x-turnstile-token': 'fresh-token' } } })
    assert.equal(navigations.length, 1, 'a successful resubmit continues to the application')

    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
    await act(async () => { root.render(translated(<AuthForm key="without-turnstile" mode="sign-up" />)) })
    assert.equal(container.querySelector('[data-slot="turnstile"]'), null)
    assert.equal((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled, false, 'local signup without a configured site key stays available')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (originalSiteKey === undefined) delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
    else process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = originalSiteKey
  }
})
