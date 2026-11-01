import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

// Real PostgreSQL and the app's Better Auth token sealing. No GitHub call is
// made: the connection receives the identity and token the callback fetched.
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
  t.after(async () => {
    await pool.query('delete from "user" where id = any($1)', [[first, second, legacy]])
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
    assert.deepEqual(await connection.githubConnectionToken(first), { token: 'token-first', githubAccountId: githubId })
    assert.deepEqual(await connection.githubConnectionToken(second), { token: 'token-second', githubAccountId: githubId })
    const stored = (await pool.query('select "accessToken", "refreshToken" from github_connections where "userId" = $1', [second])).rows[0]
    assert.notEqual(stored.accessToken, 'token-second')
    assert.notEqual(stored.refreshToken, 'refresh-second')
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
    const { cookie } = connection.startGitHubConnect(first)
    const state = cookie.value.slice(0, cookie.value.indexOf('.'))
    assert.equal(connection.githubConnectUser(state, cookie.value), first)
    assert.equal(connection.githubConnectUser('better-auth-state', cookie.value), null)
    assert.equal(connection.githubConnectUser(`${state}x`, cookie.value), null)
    assert.equal(connection.githubConnectUser(state, undefined), null)
    const callback = `http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=better-auth-state`
    assert.equal(await handleGitHubConnectCallback(new Request(callback, { headers: { cookie: `${cookie.name}=${cookie.value}` } })), null)
    assert.equal(await handleGitHubConnectCallback(new Request(`http://localhost${connection.GITHUB_CALLBACK_PATH}?code=abc&state=${state}`)), null)
  })

  await t.test('a failed connect callback says why when it can: cancelled on GitHub, or another Mikka session', async () => {
    const { cookie } = connection.startGitHubConnect(first)
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
