import { COMPOSIO_AUTH_CALLBACK_PATH, oauthResumePath, safeAuthReturn } from '@/lib/auth-return'
import { oauthAccountNotLinkedProvider, ssoRefusalHasOwnNotice } from '@/lib/auth-error'
import { withBasePath } from '@/lib/base-path'
import { desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'
import { webAuthFlow } from '@/lib/web-connection/auth'
import { localeHref, localeOf, withoutLocale } from '../../../desktop/src/renderer/location'

/** Preserve the original sign-in/up page's validated handoff and OAuth query
 * contract. Duplicate values remain arrays rather than becoming a first value. */
export function webAuthentication(location: URL) {
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(location.searchParams.keys())) {
    const values = location.searchParams.getAll(key)
    query[key] = values.length === 1 ? values[0] : values
  }
  const mode = withoutLocale(location.pathname) === '/sign-up' ? 'sign-up' as const : 'sign-in' as const
  const next = safeAuthReturn(typeof query.next === 'string' ? query.next : undefined)
  const state = desktopAuthState(query.desktop_state)
  const callback = desktopLoopbackCallback(query.desktop_callback)
  const desktopFlow = query.desktop === '1' && state && callback
    ? { state, callback, next: safeAuthReturn(typeof query.desktop_next === 'string' ? query.desktop_next : undefined) } : null
  const webFlow = desktopFlow ? null : webAuthFlow(query)
  const oauthResume = !webFlow && mode === 'sign-in' ? oauthResumePath(query) : null
  const composioResume = !webFlow && next === COMPOSIO_AUTH_CALLBACK_PATH ? withBasePath(next) : undefined
  return {
    mode, next, addAccount: query.addAccount === '1', desktopFlow, webFlow, oauthResume, composioResume,
    desktopRefused: Boolean((desktopFlow || webFlow) && query.oauth),
    // A company SSO refusal returns with sso=failed and its own ENTERPRISE_* error; the auth-sso slot shows that
    // notice. Refusal (desktopRefused above) stays derived from oauth alone.
    oauthFailed: query.oauth === 'failed' || (Boolean(query.error) && !ssoRefusalHasOwnNotice(query.sso, query.error)),
    oauthAccountNotLinked: oauthAccountNotLinkedProvider(query.error, query.provider),
    continueGoogle: mode === 'sign-in' && query.continue === 'google',
    continueGitHub: mode === 'sign-in' && query.continue === 'github',
    continueComposio: Boolean(composioResume),
    continueURL: oauthResume ? withBasePath(oauthResume) : composioResume,
  }
}

/** This browser page only chooses the account handed to an existing PKCE
 * request. Other sign-in and OAuth continuation routes retain full bootstrap. */
export function isDesktopHandoffPage(location: URL): boolean {
  if (withoutLocale(location.pathname) !== '/sign-in') return false
  const value = webAuthentication(location)
  return Boolean(value.desktopFlow && !value.oauthResume && !value.composioResume)
}

/** A machine callback leaves the SPA through its original HTTP endpoint. */
export function authenticatedReturn(location: URL): string | null {
  const value = webAuthentication(location)
  if (value.addAccount || value.desktopRefused) return null
  if (value.oauthResume) return withBasePath(value.oauthResume)
  if (value.composioResume) return value.composioResume
  // A desktop handoff stays on the page: the person sees which account the
  // app gets, or chooses another (components/auth/desktop-account-choice.tsx).
  if (value.desktopFlow || value.webFlow) return null
  return withBasePath(localeHref(value.next, localeOf(location.pathname)))
}
