import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser } from './support/workspace-admin-db'

// Real Better Auth (the app's own config plus patches/better-auth@1.7.12.patch)
// against the isolated PostgreSQL. No GitHub call is made: the link step
// receives the profile the OAuth callback would have fetched.
test('one GitHub account links to several Mikka accounts, with any email', { skip: !dbUrl }, async t => {
  process.env.BETTER_AUTH_SECRET ||= randomBytes(32).toString('hex')
  process.env.GITHUB_CLIENT_ID ||= 'fixture-client'
  process.env.GITHUB_CLIENT_SECRET ||= 'fixture-secret'
  const [{ auth }, { linkOAuthAccount }, { pool }] = await Promise.all([import('../lib/auth'), import('better-auth/oauth2'), import('../lib/db')])
  const context = await auth.$context
  const c = { context } as Parameters<typeof linkOAuthAccount>[0]
  const githubId = `fixture-${randomUUID()}`
  const first = await seedUser(pool, 'github-link-first'), second = await seedUser(pool, 'github-link-second')
  t.after(async () => {
    await pool.query('delete from "user" where id = any($1)', [[first, second]])
    await pool.end()
  })
  const link = (userId: string, accessToken: string) => linkOAuthAccount(c, {
    link: { userId, email: `${userId}@example.invalid` },
    // The GitHub email matches neither Mikka account.
    userInfo: { name: 'Fixture', email: `${githubId}@github.invalid`, emailVerified: true },
    account: { providerId: 'github', accountId: githubId, accessToken },
    profile: { id: githubId },
    scopes: ['read:user'],
  })
  const rows = () => pool.query<{ userId: string; accessToken: string }>('select "userId", "accessToken" from account where "providerId" = $1 and "accountId" = $2 order by "createdAt"', ['github', githubId]).then(r => r.rows)

  await t.test('a GitHub email different from the Mikka email links', async () => {
    assert.deepEqual(await link(first, 'token-first'), { linked: true })
    assert.deepEqual((await rows()).map(row => row.userId), [first])
  })

  await t.test('the same GitHub account links to a second Mikka account with its own row and token', async () => {
    assert.deepEqual(await link(second, 'token-second'), { linked: true })
    const linked = await rows()
    assert.deepEqual(linked.map(row => row.userId), [first, second])
    assert.notEqual(linked[0].accessToken, linked[1].accessToken)
  })

  await t.test('relinking updates the current user\'s row only', async () => {
    const before = await rows()
    assert.deepEqual(await link(second, 'token-second-renewed'), { linked: true })
    const after = await rows()
    assert.equal(after.length, 2)
    assert.equal(after[0].accessToken, before[0].accessToken)
    assert.notEqual(after[1].accessToken, before[1].accessToken)
  })

  await t.test('sign-in with a shared GitHub account lands on the earliest-linked Mikka account', async () => {
    const owner = await context.internalAdapter.findAccountOwnerByKey({ providerId: 'github', accountId: githubId })
    assert.equal(owner?.kind, 'owned')
    assert.equal(owner.kind === 'owned' && owner.user.id, first)
    assert.equal((await context.internalAdapter.findAccountByKey({ providerId: 'github', accountId: githubId }))?.userId, first)
  })
})
