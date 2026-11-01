import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'

const origin = 'https://app.example'
const callback = 'http://127.0.0.1:49152/auth/callback'
const state = 'abcdefghijklmnop1234'
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
mock.module('next/navigation', { namedExports: { redirect: (url: string) => { throw new Error(`redirect:${url}`) } } })
mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => (key: string) => key } })
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string) => key } })
stub('../i18n/navigation.ts', { getPathname: ({ href }: { href: string }) => `/en${href}`, redirect: () => { throw new Error('unexpected locale redirect') } })
stub('../lib/auth.ts', { auth: { api: { getSession: async () => null } }, oauthCallbackBaseURL: origin, googleEnabled: true, githubEnabled: true })
stub('../lib/email-sign-in.ts', { emailSignInEnabled: async () => false })
stub('../lib/acceptance.ts', { isAcceptanceEnabled: () => false })
stub('../app/actions/issues.ts', { listIssues: async () => [], saveIssue: async () => ({}) })
stub('../components/blocks/auth-19/components/auth.tsx', { Auth: ({ children }: { children: ReactNode }) => children })
stub('../components/ui/button.tsx', { Button: () => null })
stub('../components/auth/turnstile.tsx', { Turnstile: () => null })
let onGoogleSignIn: () => Promise<void>
stub('../components/blocks/auth-19/components/sign-in-card.tsx', { SignInCard: (props: { onGoogleSignIn: () => Promise<void> }) => { onGoogleSignIn = props.onGoogleSignIn; return null } })
const socialCalls: { provider: string; callbackURL: string }[] = []
stub('../lib/auth-client.ts', { authClient: { signIn: { social: async (options: { provider: string; callbackURL: string }) => { socialCalls.push(options); return { data: { url: 'https://accounts.google.com/oauth' } } } } } })

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('the desktop callback survives the sign-in page and Google callback', async () => {
  const query = new URLSearchParams({ desktop: '1', desktop_state: state, desktop_next: '/', desktop_callback: callback })
  const request = new NextRequest(`${origin}/mikka/en/sign-in?${query}`, { nextConfig: { basePath: '/mikka' } })
  // Next versions differ in loopback normalization. The application must
  // preserve the canonical callback through the complete OAuth handoff.
  const { default: proxy } = await import('../proxy')
  const response = proxy(request)
  assert.equal(response.status, 200)
  const localizedURL = new URL(response.headers.get('x-middleware-rewrite') ?? request.url)
  const { default: SignInPage } = await import('../app/[locale]/sign-in/page')
  const page = await SignInPage({ searchParams: Promise.resolve(Object.fromEntries(localizedURL.searchParams)) })
  assert.deepEqual(page.props.desktopFlow, { state, next: '/', callback })

  let destination: string | undefined
  const browser = { location: { origin, href: request.url, assign: (url: string) => { destination = url } } }
  Object.assign(browser, { self: browser, top: browser })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  renderToStaticMarkup(page)
  await onGoogleSignIn()
  assert.equal(socialCalls.length, 1)
  assert.equal(socialCalls[0].provider, 'google')
  const target = new URL(socialCalls[0].callbackURL)
  const { BASE_PATH } = await import('../lib/base-path')
  assert.equal(target.pathname, `${BASE_PATH}/api/desktop/return`)
  assert.equal(target.searchParams.get('state'), state)
  assert.equal(target.searchParams.get('callback'), callback)
  assert.equal(destination, 'https://accounts.google.com/oauth')
})
