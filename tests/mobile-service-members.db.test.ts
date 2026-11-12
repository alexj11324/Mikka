import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { serve } from 'srvx/node'
import { parseSetCookieHeader } from 'better-auth/cookies'
import { apiAliases } from '../apps/api/compat-aliases.mjs'
import { createApiHandler } from '../apps/api/src/application'
import { routes } from '../apps/api/generated/routes'
import { dbUrl, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('mobile Settings and confirmed browser handoff require a current team administrator on the serving host', { skip: !dbUrl }, async t => {
  // Resolve headers, locale and request context exactly as the registered API runtime does.
  const aliases: Record<string, string> = apiAliases
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const alias = specifier !== '@' && aliases[specifier]
    return next(alias ? pathToFileURL(alias).href : specifier, context)
  } })
  t.after(() => hooks.deregister())
  const app = createApiHandler(routes)
  const runtime = serve({ manual: true, silent: true, gracefulShutdown: false, fetch: request => app.fetch(request) })
  const listener = createServer(runtime.node!.handler)
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  t.after(async () => {
    listener.closeAllConnections()
    await new Promise<void>(resolve => listener.close(() => resolve()))
    await runtime.close()
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const origin = 'http://127.0.0.1:' + address.port
  const previous = { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, MIKKA_EDITION: process.env.MIKKA_EDITION, MIKKA_BASE_PATH: process.env.MIKKA_BASE_PATH }
  Object.assign(process.env, { BETTER_AUTH_URL: origin, MIKKA_BASE_PATH: '/mikka' })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const [{ pool }, { workspacePool }, { auth: provider }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db'), import('../lib/auth')])
  const owner = await seedUser(pool, 'mobile-members-owner'), member = await seedUser(pool, 'mobile-members-member')
  const first = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const second = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  t.after(async () => {
    try {
      await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1::text[])', [[owner, member]])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, member]])
    } finally { await Promise.all([pool.end(), workspacePool.end()]) }
  })
  const auth = await provider.$context
  const sessionCookie = async (userId: string) => {
    const session = await auth.internalAdapter.createSession(userId)
    const signature = createHmac('sha256', auth.secret).update(session.token).digest('base64')
    return auth.authCookies.sessionToken.name + '=' + encodeURIComponent(session.token + '.' + signature)
  }
  const cookie = await sessionCookie(owner), memberCookie = await sessionCookie(member)
  const { withBasePath } = await import('../lib/base-path')
  const personal = await seedPersonalWorkspace(pool, owner)
  const api = origin + '/mikka/api/'
  const settings = async (credentials: string, workspaceId: string) => {
    const response = await fetch(api + 'mobile/settings', { headers: { cookie: credentials, 'x-mikka-workspace-id': workspaceId } })
    assert.equal(response.status, 200)
    return (await response.json()).workspace
  }
  const members = (id: string) => '/settings/members?workspace=' + id
  const open = async (credentials: string, workspaceId: string) => {
    const generated = await fetch(api + 'auth/one-time-token/generate', { headers: { cookie: credentials } })
    assert.equal(generated.status, 200)
    const { token } = await generated.json()
    assert.ok(token)
    return fetch(api + 'mobile/open?' + new URLSearchParams({ to: members(workspaceId), token }), { redirect: 'manual' })
  }
  const confirm = async (response: Response, browserCookie = '') => {
    assert.equal(response.status, 200)
    const pending = response.headers.getSetCookie()
    assert.equal(pending.length, 1)
    assert.ok(pending[0].startsWith('mikka-mobile-handoff='))
    const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())?.[1]
    assert.ok(csrf)
    return fetch(api + 'mobile/open', { method: 'POST', redirect: 'manual',
      headers: { cookie: [pending[0].split(';')[0], browserCookie].filter(Boolean).join('; '), origin }, body: new URLSearchParams({ csrf }) })
  }
  process.env.MIKKA_EDITION = 'community'
  assert.equal((await settings(cookie, first.id)).serviceIdentityManagementPath, undefined)
  assert.equal((await open(cookie, first.id)).status, 403)
  process.env.MIKKA_EDITION = 'cloud'
  assert.equal((await settings(cookie, first.id)).serviceIdentityManagementPath, members(first.id))
  assert.equal((await settings(cookie, personal)).serviceIdentityManagementPath, undefined)
  assert.equal((await settings(memberCookie, first.id)).serviceIdentityManagementPath, undefined)
  const { createLegacyPersonalAccessToken } = await import('../lib/tokens/store')
  const pat = await createLegacyPersonalAccessToken(owner, first.id, { name: 'Mobile handoff fixture' })
  const patSettings = await fetch(api + 'mobile/settings', { headers: { authorization: 'Bearer ' + pat.token, 'x-mikka-workspace-id': first.id } })
  assert.equal(patSettings.status, 200)
  assert.equal((await patSettings.json()).workspace.serviceIdentityManagementPath, undefined)
  assert.equal((await open(cookie, personal)).status, 403)
  assert.equal((await open(memberCookie, first.id)).status, 403)
  assert.equal((await open(memberCookie, second.id)).status, 403)
  const uncredentialed = await fetch(api + 'mobile/open?' + new URLSearchParams({ to: members(first.id) }), { redirect: 'manual' })
  assert.equal(uncredentialed.status, 403)
  const confirmed = await confirm(await open(cookie, first.id))
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.headers.get('location'), origin + withBasePath(members(first.id)))
  assert.ok(confirmed.headers.getSetCookie().some(value => value.startsWith('mikka-workspace=' + first.id + ';')))
  const browserSession = confirmed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const accessible = await fetch(api + 'workspaces/' + first.id + '/service-identities', { headers: { cookie: browserSession } })
  assert.equal(accessible.status, 200)
  assert.deepEqual((await accessible.json()).identities, [])
  const pending = await open(cookie, first.id)
  await pool.query(`UPDATE mikka_workspace_members SET role='member' WHERE "workspaceId"=$1 AND "userId"=$2`, [first.id, owner])
  const downgraded = await confirm(pending, memberCookie)
  assert.equal(downgraded.status, 403)
  const businessCookies = [auth.authCookies.sessionToken.name, auth.authCookies.sessionData.name, 'mikka-workspace']
  const received = parseSetCookieHeader(downgraded.headers.get('set-cookie') ?? '')
  const activeBusinessCookieWritten = [...received].some(([name, value]) =>
    businessCookies.some(key => name === key || name.startsWith(key + '.')) && value.value &&
    (value['max-age'] !== undefined ? value['max-age'] > 0 : !value.expires || value.expires.getTime() > Date.now()))
  assert.equal(activeBusinessCookieWritten, false, 'denied confirmation must not write a live business cookie')
})
