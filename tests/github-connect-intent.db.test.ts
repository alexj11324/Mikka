import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

// Production 2026-11-03: the desktop app was signed in as one Mikka account and
// the system browser as another; Link GitHub connected the browser's account.
// A one-time token from the app now names the account the link is for.
let sessionUser: string | null = null
mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser }, session: { id: 's' } } : null } } } })

test('Link GitHub from the desktop links the app\'s account, never the browser\'s other one', { skip: !dbUrl }, async t => {
  process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('hex')
  process.env.GITHUB_CLIENT_ID ||= 'fixture-client'
  process.env.GITHUB_CLIENT_SECRET ||= 'fixture-secret'
  process.env.BETTER_AUTH_URL ||= 'https://mikka.test'
  const { withBasePath } = await import('../lib/base-path')
  const [intents, { GET: connect }, { pool }] = await Promise.all([
    import('../lib/github/connect-intent'), import('../app/api/integrations/github/connect/route'), import('../lib/db'),
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
})
