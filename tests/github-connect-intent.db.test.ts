import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

// Production 2026-11-03: the desktop app was signed in as one Mikka account and
// the system browser as another; Link GitHub connected the browser's account.
// A one-time token from the app now names the account the link is for.
let sessionUser: string | null = null
// Tokens are sealed the way the app seals them (encryptOAuthTokens with its secret).
const sealing = { options: { account: { encryptOAuthTokens: true } }, secretConfig: randomBytes(32).toString('hex') }
mock.module('@/lib/auth', { namedExports: { auth: { $context: Promise.resolve(sealing), api: { getSession: async () => sessionUser ? { user: { id: sessionUser }, session: { id: 's' } } : null } } } })

test('Link GitHub from the desktop links the app\'s account, never the browser\'s other one', { skip: !dbUrl }, async t => {
  process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('hex')
  process.env.GITHUB_CLIENT_ID ||= 'fixture-client'
  process.env.GITHUB_CLIENT_SECRET ||= 'fixture-secret'
  process.env.BETTER_AUTH_URL ||= 'https://mikka.test'
  const { withBasePath } = await import('../lib/base-path')
  const [intents, { GET: connect }, { pool }, { handleGitHubConnectCallback }, { POST: confirmRoute }, connection] = await Promise.all([
    import('../lib/github/connect-intent'), import('../app/api/integrations/github/connect/route'), import('../lib/db'),
    import('../lib/github/connect-callback'), import('../app/api/integrations/github/connect/intent/confirm/route'), import('../lib/github/connection'),
  ])
  const app = await seedUser(pool, 'github-intent-app'), browser = await seedUser(pool, 'github-intent-browser'), stranger = await seedUser(pool, 'github-intent-stranger')
  t.after(async () => {
    await pool.query('delete from "user" where id = any($1)', [[app, browser, stranger]])
    await pool.end()
  })
  const open = async (as: string | null, intent?: string) => {
    sessionUser = as
    const url = new URL('https://mikka.test/mikka/api/integrations/github/connect')
    if (intent !== undefined) url.searchParams.set('intent', intent)
    const response = await connect(new Request(url))
    return { location: new URL(response.headers.get('location')!), cookie: response.headers.get('set-cookie') ?? '' }
  }

  await t.test('a browser signed in as another account starts nothing, keeps the token, and each side sees what it may', async () => {
    const { token } = await intents.createConnectIntent(pool, app)
    const refused = await open(browser, token)
    assert.equal(refused.location.hostname, 'mikka.test')
    assert.deepEqual([refused.location.searchParams.get('github'), refused.location.searchParams.get('reason'), refused.location.searchParams.get('intent')], ['link-failed', 'browser-account', token])
    assert.ok(!refused.cookie.includes('mikka-github-connect'), 'no GitHub authorization was started')
    // The browser: its own address, and the app's masked.
    const seen = await intents.readConnectIntent(pool, token, browser)
    assert.equal(seen.state, 'otherAccount')
    assert.equal(seen.state === 'otherAccount' && seen.browserAccount, `${browser}@example.invalid`)
    assert.equal(seen.state === 'otherAccount' && seen.appAccount, `gi•••@example.invalid`)
    // The app: the browser's account, so it can say which one is signed in there.
    assert.deepEqual(await intents.readConnectIntent(pool, token, app), { state: 'waiting', browserAccount: `${browser}@example.invalid` })
    // Anyone else holding the token learns nothing.
    assert.deepEqual(await intents.readConnectIntent(pool, token, stranger), { state: 'expired' })
    // After switching the browser to the app's account, the same link goes on to GitHub, for that account.
    const started = await open(app, token)
    assert.equal(started.location.hostname, 'github.com')
    assert.match(started.cookie, new RegExp(`mikka-github-connect=ghc_[^;]*\\.${app}`))
    assert.deepEqual(await intents.readConnectIntent(pool, token, app), { state: 'started', browserAccount: null })
  })

  await t.test('a token is single use, short lived and cannot be used by another account', async () => {
    const { token } = await intents.createConnectIntent(pool, app)
    assert.equal((await open(app, token)).location.hostname, 'github.com')
    const again = await open(app, token)
    assert.deepEqual([again.location.searchParams.get('reason'), again.location.hostname], ['expired', 'mikka.test'])
    // Another account cannot take over a used token either.
    assert.equal((await open(browser, token)).location.searchParams.get('reason'), 'expired')
    const old = await intents.createConnectIntent(pool, app, new Date(Date.now() - intents.INTENT_TTL_MS - 1000))
    assert.equal((await open(app, old.token)).location.searchParams.get('reason'), 'expired')
    assert.equal((await open(app, 'ghi_not-a-token')).location.searchParams.get('reason'), 'expired')
    // Only a hash is stored.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM github_connect_intents WHERE "tokenHash"=$1', [token])).rows[0].n, 0)
  })

  await t.test('a browser that is not signed in comes back to GitHub\'s page with the token after signing in', async () => {
    const { token } = await intents.createConnectIntent(pool, app)
    const signIn = await open(null, token)
    assert.equal(signIn.location.pathname, withBasePath('/sign-in'))
    assert.equal(signIn.location.searchParams.get('next'), `/?section=plugins&app=github&intent=${token}`)
    const { safeAuthReturn } = await import('../lib/auth-return')
    assert.equal(safeAuthReturn(signIn.location.searchParams.get('next')!), `/?section=plugins&app=github&intent=${token}`)
    assert.equal(safeAuthReturn('/?section=plugins&app=gmail&intent=' + token), '/')
  })

  await t.test('the web page links its own session as before', async () => {
    assert.equal((await open(app)).location.hostname, 'github.com')
  })

  // RFC 8252: an app that takes the return on its own loopback (127.0.0.1) links its own account
  // whatever the browser is signed in as; GitHub's answer waits until the app proves the return
  // reached this computer with the verifier only it holds. PKCE (S256) runs between server and GitHub.
  const s256 = (value: string) => createHash('sha256').update(value).digest('base64url')
  const loopbackLink = async () => {
    const verifier = randomBytes(32).toString('base64url'), returnState = randomBytes(32).toString('base64url')
    const { token } = await intents.createConnectIntent(pool, app, new Date(), { returnTo: 'http://127.0.0.1:43123/return', returnState, challenge: s256(verifier) })
    return { token, verifier, returnState }
  }
  const realFetch = globalThis.fetch
  const githubSaw: { verifier?: string; code?: string } = {}
  const github = (login: string) => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(String(init?.body))
        githubSaw.verifier = body.get('code_verifier') ?? undefined; githubSaw.code = body.get('code') ?? undefined
        return Response.json({ access_token: `token-${login}`, expires_in: 28_800, refresh_token: `refresh-${login}`, refresh_token_expires_in: 15_897_600 })
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 424242, login })
      return realFetch(input, init)
    }) as typeof fetch
  }
  const callback = async (query: Record<string, string>) => {
    sessionUser = null
    const url = new URL(connection.GITHUB_CALLBACK_PATH, 'https://mikka.test')
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await handleGitHubConnectCallback(new Request(url))
    return response ? new URL(response.headers.get('location')!) : null
  }
  const confirm = async (as: string, token: string, verifier: string) => {
    sessionUser = as
    return (await confirmRoute(new Request('https://mikka.test/mikka/api/integrations/github/connect/intent/confirm', { method: 'POST', body: JSON.stringify({ token, verifier }), headers: { 'content-type': 'application/json' } }))).status
  }
  t.after(() => { globalThis.fetch = realFetch })

  await t.test('loopback: a browser signed in as anyone (or no one) goes to GitHub with PKCE, and the answer waits for the app', async () => {
    await pool.query('DELETE FROM github_connections WHERE "userId"=$1', [app])
    const { token, verifier, returnState } = await loopbackLink()
    const start = await open(browser, token)
    assert.equal(start.location.origin, 'https://github.com')
    assert.equal(start.location.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(!start.cookie.includes('mikka-github-connect'), 'no cookie: the state names the link')
    const state = start.location.searchParams.get('state')!
    github('alex-github')
    const back = await callback({ code: 'code-1', state })
    assert.equal(`${back!.origin}${back!.pathname}`, 'http://127.0.0.1:43123/return')
    assert.deepEqual([back!.searchParams.get('state'), back!.searchParams.get('result')], [returnState, 'connected'])
    assert.equal(s256(githubSaw.verifier!), start.location.searchParams.get('code_challenge'), 'PKCE: the verifier matches the challenge sent to GitHub')
    // Nothing is linked yet: not for the app's account, and never for the browser's.
    assert.equal(await connection.githubConnection(app), null)
    assert.equal(await connection.githubConnection(browser), null)
    // The wrong verifier, or another account, links nothing.
    assert.equal(await confirm(app, token, randomBytes(32).toString('base64url')), 409)
    assert.equal(await confirm(browser, token, verifier), 409)
    // The app's own verifier, from the app's session: linked to the app's account.
    assert.equal(await confirm(app, token, verifier), 200)
    assert.deepEqual(await connection.githubConnection(app), { githubAccountId: '424242', githubLogin: 'alex-github' })
    assert.equal((await connection.githubConnectionToken(app))?.token, 'token-alex-github')
    assert.equal(await connection.githubConnection(browser), null)
    // Once: a second confirm or a replayed callback does nothing.
    assert.equal(await confirm(app, token, verifier), 409)
    assert.equal((await callback({ code: 'code-2', state }))!.searchParams.get('result'), 'failed')
    // The answer is not kept on the link after it is used.
    assert.equal((await pool.query('SELECT "accessToken","codeVerifier" FROM github_connect_intents WHERE "githubLogin"=$1 AND "userId"=$2', ['alex-github', app])).rows[0].accessToken, null)
  })

  await t.test('loopback: a link opened somewhere else never becomes a connection without the app', async () => {
    await pool.query('DELETE FROM github_connections WHERE "userId"=$1', [app])
    const { token } = await loopbackLink()
    // Someone with the link authorizes their own GitHub in their own browser.
    const start = await open(stranger, token)
    github('stranger-github')
    await callback({ code: 'code-3', state: start.location.searchParams.get('state')! })
    // Their return goes to their own 127.0.0.1, never this app's; without the app's verifier nothing is linked.
    assert.equal(await confirm(stranger, token, randomBytes(32).toString('base64url')), 409)
    assert.equal(await connection.githubConnection(app), null)
    // And the link is spent: the person's own browser gets a fresh one.
    assert.equal((await open(app, token)).location.searchParams.get('reason'), 'expired')
  })

  await t.test('loopback: cancelled on GitHub returns to the app as cancelled; a bad return address is refused', async () => {
    const { token } = await loopbackLink()
    const start = await open(null, token)
    assert.equal(start.location.origin, 'https://github.com', 'a browser signed in to nothing goes on too')
    const back = await callback({ error: 'access_denied', state: start.location.searchParams.get('state')! })
    assert.equal(back!.searchParams.get('result'), 'cancelled')
    for (const returnTo of ['http://localhost:1/return', 'https://127.0.0.1:1/return', 'http://127.0.0.1/return', 'http://127.0.0.1:1/return?x=1', 'http://127.0.0.1:1/other', 'http://evil.example:1/return']) {
      assert.equal(intents.loopbackReturn(returnTo), null, returnTo)
    }
    assert.equal(intents.loopbackStart({ returnTo: 'http://127.0.0.1:1/return', returnState: 'short', challenge: s256('x') }), null)
  })
})
