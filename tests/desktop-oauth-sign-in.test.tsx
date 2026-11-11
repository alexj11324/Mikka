import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webAuthentication, authenticatedReturn, isDesktopHandoffPage } from '../apps/frontend/src/web/auth-routing'
import { desktopAuthCallbackPath, desktopAuthCallbackURL } from '../lib/desktop-auth'
import { BASE_PATH } from '../lib/base-path'

// The web app renders sign-in itself (components/auth-form.tsx behind
// apps/frontend/src/web/platform.tsx); no Next page or middleware sits in
// front of it. This pins the desktop OAuth handoff the browser must preserve.
const origin = 'https://app.example'
const callback = 'http://127.0.0.1:49152/auth/callback'
const state = 'abcdefghijklmnop1234'

function signIn(query: Array<[string, string]> = [], path = `${BASE_PATH}/en/sign-in`) {
  const url = new URL(`${origin}${path}`)
  url.search = new URLSearchParams(query).toString()
  return url
}

const handoff: Array<[string, string]> = [
  ['desktop', '1'], ['desktop_state', state], ['desktop_next', '/'], ['desktop_callback', callback],
]

test('the desktop handoff survives the sign-in page and the Google callback', () => {
  const location = signIn(handoff)
  const auth = webAuthentication(location)
  // The props the sign-in page hands to AuthForm.
  assert.deepEqual(auth.desktopFlow, { state, next: '/', callback })
  assert.equal(auth.mode, 'sign-in')
  assert.equal(auth.oauthResume, null)
  assert.equal(auth.composioResume, undefined)
  // A validated PKCE handoff reads identity only, never the workspace.
  assert.equal(isDesktopHandoffPage(location), true)
  // The page stays put, so the person sees which account the app receives.
  assert.equal(authenticatedReturn(location), null)

  // The callbackURL authClient.signIn.social receives: the API return path,
  // free of the app base path that Better Auth adds itself, carrying the same
  // state, page and loopback callback.
  assert.equal(desktopAuthCallbackPath(state, '/', callback),
    `/api/desktop/return?state=${state}&next=%2F&callback=${encodeURIComponent(callback)}`)
  const target = new URL(desktopAuthCallbackURL(origin, state, '/', callback))
  assert.equal(target.pathname, `${BASE_PATH}/api/desktop/return`)
  assert.equal(target.searchParams.get('state'), state)
  assert.equal(target.searchParams.get('next'), '/')
  assert.equal(target.searchParams.get('callback'), callback)
})

test('a refused handoff, an extra account and a web OAuth continuation are told apart', () => {
  // The return route sends a refused handoff back with oauth=failed: show that,
  // never redirect to it again.
  assert.equal(webAuthentication(signIn([...handoff, ['oauth', 'failed']])).desktopRefused, true)
  assert.equal(webAuthentication(signIn([...handoff, ['addAccount', '1']])).addAccount, true)

  // A web OAuth continuation resumes the authorize endpoint, not a desktop handoff.
  const continuation = webAuthentication(signIn([['sig', 'signed'], ['client_id', 'client'], ['scope', 'a'], ['scope', 'b'], ['exp', '123'], ['prompt', 'login']]))
  assert.equal(continuation.desktopFlow, null)
  assert.ok(continuation.oauthResume)
  assert.equal(isDesktopHandoffPage(signIn([['sig', 'signed'], ['client_id', 'client']])), false)
})

test('an unvalidated or duplicated handoff never becomes a desktop flow', () => {
  // A loopback callback off this machine is refused outright.
  assert.equal(webAuthentication(signIn([['desktop', '1'], ['desktop_state', state], ['desktop_callback', 'https://foreign.example/auth/callback']])).desktopFlow, null)
  // Duplicate values stay arrays rather than collapsing to the first one.
  assert.equal(webAuthentication(signIn([...handoff, ['desktop_state', state]])).desktopFlow, null)
  assert.equal(webAuthentication(signIn([...handoff, ['desktop_callback', callback]])).desktopFlow, null)
  // An invalid nonce is not a handoff at all.
  assert.equal(webAuthentication(signIn([['desktop', '1'], ['desktop_state', 'short'], ['desktop_callback', callback]])).desktopFlow, null)

  // Only the sign-in page carries a handoff; sign-up is a separate page.
  const signUp = signIn(handoff, `${BASE_PATH}/en/sign-up`)
  assert.equal(webAuthentication(signUp).mode, 'sign-up')
  assert.equal(isDesktopHandoffPage(signUp), false)
})
