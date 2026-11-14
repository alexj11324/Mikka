import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

// Real PostgreSQL and the app's Better Auth token sealing. No GitHub call is
// made: callbacks are seeded and only the fixed OAuth HTTP response is stubbed.
test('Plugins → GitHub connections are per Mikka user and leave the login identity alone', { skip: !dbUrl }, async t => {
  process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('hex')
  process.env.GITHUB_CLIENT_ID ||= 'fixture-client'
  process.env.GITHUB_CLIENT_SECRET ||= 'fixture-secret'
  process.env.BETTER_AUTH_URL ||= 'https://mikka.test'
  const [connection, { linkedGitHubAccountId }, { handleGitHubConnectCallback }, { pool }] = await Promise.all([
    import('../lib/github/connection'), import('../lib/github/repository-installation'), import('../lib/github/connect-callback'), import('../lib/db'),
  ])
  const githubId = String(1_000_000_000 + Math.floor(Math.random() * 1_000_000_000))
  const first = await seedUser(pool, 'github-connect-first'), second = await seedUser(pool, 'github-connect-second'), legacy = await seedUser(pool, 'github-connect-legacy')
  const users = [first, second, legacy]
  t.after(async () => {
    await pool.query('delete from "user" where id = any($1)', [users])
    await pool.end()
  })
  const identity = { githubAccountId: githubId, githubLogin: 'octo-fixture' }
  const accountRows = () => pool.query('select count(*)::int as n from account where "providerId" = $1 and "accountId" = $2', ['github', githubId]).then(r => r.rows[0].n)

  await t.test('two Mikka users connect the same GitHub account and both resolve to it', async () => {
    await connection.saveGitHubConnection(first, identity, { access_token: 'token-first' })
    await connection.saveGitHubConnection(second, identity, { access_token: 'token-second', expires_in: 28_800, refresh_token: 'refresh-second', refresh_token_expires_in: 15_897_600 })
    assert.equal(await linkedGitHubAccountId(first), githubId)
    assert.equal(await linkedGitHubAccountId(second), githubId)
    assert.deepEqual(await connection.githubConnection(second), identity)
    assert.equal(await accountRows(), 0, 'the Better Auth login identity is never written')
  })

  await t.test('each user gets their own token, sealed at rest', async () => {
    assert.deepEqual(await connection.githubConnectionToken(first), { token: 'token-first', githubAccountId: githubId, expiresAt: null })
    const secondToken = await connection.githubConnectionToken(second, { minValidityMs: 45 * 60_000 })
    assert.equal(secondToken?.token, 'token-second', 'a token valid for longer than asked is used as stored')
    assert.equal(secondToken?.githubAccountId, githubId)
    assert.ok(secondToken?.expiresAt && secondToken.expiresAt.getTime() > Date.now() + 7 * 60 * 60_000)
    const stored = (await pool.query('select "accessToken", "refreshToken" from github_connections where "userId" = $1', [second])).rows[0]
    assert.notEqual(stored.accessToken, 'token-second')
    assert.notEqual(stored.refreshToken, 'refresh-second')
  })

  const expiredConnection = async (label: string) => {
    const userId = await seedUser(pool, label)
    users.push(userId)
    await connection.saveGitHubConnection(userId, identity, { access_token: 'access-before-rotation', expires_in: 3600,
      refresh_token: 'refresh-before-rotation', refresh_token_expires_in: 86_400 })
    await pool.query('UPDATE github_connections SET "accessTokenExpiresAt"=now()-interval \'1 second\' WHERE "userId"=$1', [userId])
    return userId
  }
  const storedConnection = async (userId: string) => (await pool.query<{
    accessToken: string; refreshToken: string; accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date; updatedAt: Date;
  }>('SELECT "accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt","updatedAt" FROM github_connections WHERE "userId"=$1', [userId])).rows[0]!

  for (const cancellation of ['abort', 'deadline'] as const) await t.test(`an admitted rotating refresh commits before caller ${cancellation} and is reused without another exchange`, { timeout: 10_000 }, async sub => {
    const userId = await expiredConnection(`github-connect-${cancellation}`)
    const before = await storedConnection(userId)
    const controller = new AbortController(), reason = new DOMException('Fixture request cancelled', 'AbortError')
    const budget = { deadline: Date.now() + 25_000, signal: controller.signal }
    const started = deferred<RequestInit>(), release = deferred<Response>()
    const replacement = { access_token: 'access-after-rotation', expires_in: 3600,
      refresh_token: 'refresh-after-rotation', refresh_token_expires_in: 86_400 }
    const fetcher = sub.mock.method(globalThis, 'fetch', async (target: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(target), 'https://github.com/login/oauth/access_token')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'refresh-before-rotation')
      assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token')
      assert.ok(init?.signal)
      started.resolve(init)
      return release.promise
    })
    let settled = false
    const pending = connection.githubConnectionToken(userId, { budget })
    const outcome = pending.then(
      value => { settled = true; started.reject(new Error('Refresh returned before the OAuth exchange')); return { value, error: undefined } },
      error => { settled = true; started.reject(error); return { value: undefined, error: error as unknown } },
    )
    try {
      const init = await started.promise
      if (cancellation === 'abort') controller.abort(reason)
      else budget.deadline = Date.now() - 1
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'caller cancellation cannot abandon the in-flight rotating exchange')
      assert.equal(init.signal!.aborted, false, 'the OAuth exchange keeps its independent deadline')
      assert.notEqual(init.signal, controller.signal)
      assert.deepEqual(await storedConnection(userId), before, 'new ciphertext is not visible before the response')
      release.resolve(Response.json(replacement))
      const result = await outcome
      assert.equal(result.value, undefined)
      if (cancellation === 'abort') assert.equal(result.error, reason)
      else assert.ok(result.error instanceof DOMException && result.error.name === 'TimeoutError')
      const saved = await storedConnection(userId)
      assert.notEqual(saved.accessToken, before.accessToken)
      assert.notEqual(saved.refreshToken, before.refreshToken)
      assert.equal(await connection.unsealGitHubSecret(saved.accessToken), replacement.access_token)
      assert.equal(await connection.unsealGitHubSecret(saved.refreshToken), replacement.refresh_token)
      const reused = await connection.githubConnectionToken(userId, { budget: { deadline: Date.now() + 25_000 } })
      assert.equal(reused?.token, replacement.access_token)
      assert.equal(reused?.githubAccountId, githubId)
      assert.equal(fetcher.mock.callCount(), 1, 'the aborted caller and later reader make no extra provider requests')
    } finally {
      release.resolve(Response.json(replacement))
      await outcome
      fetcher.mock.restore()
    }
  })

  await t.test('a held connection row times out before any token POST and leaves ciphertext untouched', { timeout: 10_000 }, async sub => {
    const userId = await expiredConnection('github-connect-lock-timeout')
    const before = await storedConnection(userId)
    const fetcher = sub.mock.method(globalThis, 'fetch', async () => { throw new Error('A locked connection must not contact GitHub') })
    const locker = await pool.connect()
    const unlockOnTimeout = () => { void locker.query('ROLLBACK').catch(() => {}) }
    sub.signal.addEventListener('abort', unlockOnTimeout, { once: true })
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT "userId" FROM github_connections WHERE "userId"=$1 FOR UPDATE', [userId])
      await assert.rejects(connection.githubConnectionToken(userId, { budget: { deadline: Date.now() + 25_000 } }),
        (error: unknown) => {
          let cause = error
          while (cause && typeof cause === 'object') {
            if ('code' in cause && ['55P03', '57014'].includes(String(cause.code))) return true
            cause = 'cause' in cause ? cause.cause : null
          }
          return false
        })
      assert.equal(fetcher.mock.callCount(), 0)
      assert.deepEqual(await storedConnection(userId), before)
    } finally {
      sub.signal.removeEventListener('abort', unlockOnTimeout)
      await locker.query('ROLLBACK')
      locker.release()
      fetcher.mock.restore()
    }
  })

  await t.test('insufficient refresh budget refuses before POST without changing the connection', { timeout: 10_000 }, async sub => {
    const userId = await expiredConnection('github-connect-budget-admission')
    const before = await storedConnection(userId)
    const fetcher = sub.mock.method(globalThis, 'fetch', async () => { throw new Error('An unadmitted refresh must not contact GitHub') })
    await assert.rejects(connection.githubConnectionToken(userId, { budget: { deadline: Date.now() + 11_000 } }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError')
    assert.equal(fetcher.mock.callCount(), 0)
    assert.deepEqual(await storedConnection(userId), before)
  })

  await t.test('a GitHub sign-in account linked before connections existed still resolves; a connection wins over it', async () => {
    await pool.query(`insert into account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") values ($1, '77', 'github', $2, now(), now())`, [randomUUID(), legacy])
    assert.equal(await linkedGitHubAccountId(legacy), '77')
    await connection.saveGitHubConnection(legacy, identity, { access_token: 'token-legacy' })
    assert.equal(await linkedGitHubAccountId(legacy), githubId)
  })

  await t.test('disconnecting removes only that user\'s connection', async () => {
    await connection.disconnectGitHub(first)
    assert.equal(await linkedGitHubAccountId(first), null)
    assert.equal(await linkedGitHubAccountId(second), githubId)
    await connection.disconnectGitHub(legacy)
    assert.equal(await linkedGitHubAccountId(legacy), '77')
  })

  await t.test('GitHub sign-in callbacks stay with Better Auth unless the state is this user\'s connect state', async () => {
    const { cookie } = await connection.startGitHubConnect(first)
    const state = cookie.value.slice(0, cookie.value.indexOf('.'))
    assert.equal(connection.githubConnectUser(state, cookie.value), first)
    assert.equal(connection.githubConnectUser('better-auth-state', cookie.value), null)
    assert.equal(connection.githubConnectUser(`${state}x`, cookie.value), null)
    assert.equal(connection.githubConnectUser(state, undefined), null)
    const callback = `http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=better-auth-state`
    assert.equal(await handleGitHubConnectCallback(new Request(callback, { headers: { cookie: `${cookie.name}=${cookie.value}` } })), null)
    // A corrupted app-scoped cookie must never turn an unrelated GitHub
    // sign-in callback into a 500, nor select a later duplicate cookie.
    for (const malformed of ['%', '%E0%A4%A', '%FF']) {
      const malformedCookie = `${cookie.name}=${malformed}`
      assert.equal(await handleGitHubConnectCallback(new Request(callback, { headers: { cookie: malformedCookie } })), null)
      assert.equal(await handleGitHubConnectCallback(new Request(`http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=${state}`, { headers: { cookie: malformedCookie } })), null)
      assert.equal(await handleGitHubConnectCallback(new Request(`http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=${state}`, { headers: { cookie: `${malformedCookie}; ${cookie.name}=${cookie.value}` } })), null)
    }
    assert.equal(await handleGitHubConnectCallback(new Request(`http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=${state}`)), null)
  })

  await t.test('a failed connect callback says why when it can: cancelled on GitHub, or another Mikka session', async () => {
    const { cookie } = await connection.startGitHubConnect(first)
    const state = cookie.value.slice(0, cookie.value.indexOf('.'))
    const headers = { cookie: `${cookie.name}=${cookie.value}` }
    const reason = async (query: string) => {
      const response = await handleGitHubConnectCallback(new Request(`http://localhost${connection.GITHUB_CALLBACK_PATH}?${query}&state=${state}`, { headers }))
      const location = new URL(response!.headers.get('location')!)
      assert.equal(location.searchParams.get('github'), 'link-failed')
      return location.searchParams.get('reason')
    }
    assert.equal(await reason('error=access_denied'), 'cancelled')
    assert.equal(await reason('error=temporarily_unavailable'), null)
    // No Mikka session on the callback: the person who started is not the one returning.
    assert.equal(await reason('code=abc'), 'account')
  })
})
