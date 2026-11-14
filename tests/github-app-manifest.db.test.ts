import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser } from './support/workspace-admin-db'
import { GitHubAppSetupError, readGitHubAppConfig, saveGitHubAppConfig, type GitHubAppCredentials } from '../lib/github/app-config'
import { githubManifestHandlers } from '../lib/github/manifest-http'
import { GITHUB_MANIFEST_CALLBACK, GITHUB_MANIFEST_COOKIE } from '../lib/github/manifest'

// A private schema inside the required loopback *_e2e database prevents the
// singleton fixture from changing App configuration seen by any other suite.
test('GitHub App registration enforces server authority, session binding and single-use encrypted storage on PostgreSQL', { skip: !dbUrl }, async t => {
  const schema = `github_app_${randomUUID().replaceAll('-', '')}`
  const pool = new Pool({ connectionString: dbUrl, max: 4, options: `-c search_path=${schema},public` })
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  })
  await pool.query(`CREATE SCHEMA ${schema}`)
  // Keep both foreign keys and their cleanup locks inside the disposable schema.
  await pool.query('CREATE TABLE "user" (LIKE public."user" INCLUDING DEFAULTS INCLUDING INDEXES)')
  await pool.query(readFileSync(new URL('../drizzle/20261107171000_server_github_app.sql', import.meta.url), 'utf8'))
  const admin = await seedUser(pool, 'github-app-admin'), other = await seedUser(pool, 'github-app-other')
  const origin = 'https://selfhost.example'
  const env = { MIKKA_SERVER_ADMIN_USER_IDS: `${admin},${other}`, WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), BETTER_AUTH_URL: origin }
  let current: { user: { id: string }; session: { id: string } } | null = { user: { id: admin }, session: { id: randomUUID() } }
  const originalSession = current
  const credentials: GitHubAppCredentials = {
    id: '78412345', slug: 'self-hosted-fixture',
    pem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    webhookSecret: randomBytes(32).toString('hex'), clientId: 'Iv23.fixtureapp', clientSecret: randomBytes(32).toString('hex'),
  }
  const code = randomBytes(20).toString('hex')
  let exchanged = 0
  const handlers = githubManifestHandlers({ query: pool, session: async () => current, env,
    config: () => readGitHubAppConfig({ query: pool, env }),
    save: (app, userId) => saveGitHubAppConfig(app, userId, { query: pool, env }),
    template: { permissions: { contents: 'write', metadata: 'read' }, events: ['push'] },
    fetcher: async (url, init) => {
      exchanged++
      assert.equal(url, `https://api.github.com/app-manifests/${code}/conversions`)
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      return Response.json({ id: Number(credentials.id), slug: credentials.slug, pem: credentials.pem, webhook_secret: credentials.webhookSecret, client_id: credentials.clientId, client_secret: credentials.clientSecret })
    },
  })
  const start = (requestOrigin = origin) => handlers.POST(new Request(`${origin}/api/github/manifest`, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: '{}' }))
  let state = '', cookie = ''
  const begin = async () => {
    const response = await start()
    assert.equal(response.status, 200)
    const body = await response.json()
    state = new URL(body.action).searchParams.get('state')!
    cookie = `${GITHUB_MANIFEST_COOKIE}=${state}`
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const setCookie = response.headers.get('set-cookie')!
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=lax/)
    assert.ok(setCookie.includes(`Path=${GITHUB_MANIFEST_CALLBACK}`))
  }
  const callback = (inputState = state, inputCookie = cookie, inputOrigin = origin) => handlers.callback(new Request(`${inputOrigin}${GITHUB_MANIFEST_CALLBACK}?${new URLSearchParams({ code, state: inputState })}`, { headers: { cookie: inputCookie } }))
  const result = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('github-app')

  await t.test('unauthenticated, non-admin and cross-origin starts have no write or provider effect', async () => {
    current = null
    assert.equal((await start()).status, 401)
    current = { user: { id: 'not-a-server-admin' }, session: { id: randomUUID() } }
    assert.deepEqual(await (await handlers.GET(new Request(`${origin}/api/github/manifest`))).json(), { viewerId: 'not-a-server-admin', admin: false })
    assert.equal((await start()).status, 403)
    current = originalSession
    assert.equal((await start('https://attacker.example')).status, 403)
    assert.equal(Number((await pool.query('SELECT count(*) FROM github_app_manifest_intents')).rows[0].count), 0)
    assert.equal(exchanged, 0)
  })

  await t.test('state is hashed, and another account, session, cookie or origin cannot consume it', async () => {
    await begin()
    const row = (await pool.query('SELECT * FROM github_app_manifest_intents')).rows[0]
    assert.match(row.stateHash, /^[a-f\d]{64}$/)
    assert.ok(!JSON.stringify(row).includes(state))
    assert.equal(row.userId, admin); assert.equal(row.sessionId, originalSession.session.id); assert.equal(row.origin, origin)
    current = { user: { id: other }, session: { id: originalSession.session.id } }
    assert.equal(result(await callback()), 'state')
    current = { user: { id: admin }, session: { id: randomUUID() } }
    assert.equal(result(await callback()), 'state')
    current = originalSession
    assert.equal(result(await callback(state, `${GITHUB_MANIFEST_COOKIE}=ghm_${'x'.repeat(43)}`)), 'state')
    assert.equal((await callback(state, cookie, 'https://attacker.example')).status, 403)
    assert.equal(Number((await pool.query('SELECT count(*) FROM github_app_manifest_intents')).rows[0].count), 1)
    assert.equal(exchanged, 0)
  })

  await t.test('expiry and a revoked administrator refuse the callback before code exchange', async () => {
    await pool.query('UPDATE github_app_manifest_intents SET "expiresAt"=now()-interval \'1 second\'')
    assert.equal(result(await callback()), 'state')
    await begin()
    env.MIKKA_SERVER_ADMIN_USER_IDS = other
    assert.equal(result(await callback()), 'admin')
    env.MIKKA_SERVER_ADMIN_USER_IDS = `${admin},${other}`
    assert.equal(exchanged, 0)
  })

  await t.test('two callbacks exchange once, retain all six encrypted fields, and expose only safe status', async () => {
    const answers = await Promise.all([callback(), callback()])
    assert.deepEqual(answers.map(result).sort(), ['created', 'state'])
    assert.equal(exchanged, 1)
    for (const response of answers) {
      assert.equal(response.status, 303)
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
      assert.ok(!response.headers.get('location')!.includes(code))
    }
    const stored = (await pool.query('SELECT * FROM server_github_app')).rows[0]
    for (const value of Object.values(credentials)) assert.ok(!JSON.stringify(stored).includes(value))
    assert.deepEqual(await readGitHubAppConfig({ query: pool, env }), { source: 'database', ...credentials })
    const status = await (await handlers.GET(new Request(`${origin}/api/github/manifest`))).json()
    assert.deepEqual(status, { viewerId: admin, admin: true, configured: true, slug: credentials.slug, installUrl: `https://github.com/apps/${credentials.slug}/installations/new` })
    assert.equal((await start()).status, 409)
    assert.equal(result(await callback()), 'state')
    assert.equal(exchanged, 1)
  })

  await t.test('concurrent administrators cannot overwrite one another and a bad decryption key never falls back', async () => {
    await assert.rejects(readGitHubAppConfig({ query: pool, env: { ...env, WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), GITHUB_APP_ID: 'different-app' } }), error => error instanceof GitHubAppSetupError && error.detail === 'encryption')
    await pool.query('DELETE FROM server_github_app')
    const second = { ...credentials, id: '78412346', slug: 'second-fixture' }
    const results = await Promise.allSettled([saveGitHubAppConfig(credentials, admin, { query: pool, env }), saveGitHubAppConfig(second, other, { query: pool, env })])
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
    const rejected = results.find(value => value.status === 'rejected') as PromiseRejectedResult
    assert.ok(rejected.reason instanceof GitHubAppSetupError && rejected.reason.detail === 'configured')
    assert.deepEqual(await readGitHubAppConfig({ query: pool, env }), { source: 'database', ...(results[0].status === 'fulfilled' ? credentials : second) })
    assert.equal(Number((await pool.query('SELECT count(*) FROM server_github_app')).rows[0].count), 1)
  })
})
