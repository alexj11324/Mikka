import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enterpriseSignOutStep, parseLogoutTarget, readLogoutTarget, submitSignOutForm, type EnterpriseSignOutStep } from './logout-client'
import { routeEnterpriseSignOut } from '../../hooks/use-enterprise-sign-out'

const origin = 'https://app.example.test'
type Call = { url: string; init?: RequestInit }
function server(answers: Record<string, () => Response>) {
  const calls: Call[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const answer = answers[`${init?.method ?? 'GET'} ${url}`]
    return answer ? answer() : new Response(null, { status: 404 })
  }
  return { calls, fetch }
}
const target = (value: unknown) => () => Response.json({ target: value }, { headers: { 'cache-control': 'no-store' } })

test('the logout-target contract: null, an OIDC or SAML descriptor, anything else refused', () => {
  assert.equal(parseLogoutTarget({ target: null }), null)
  assert.deepEqual(parseLogoutTarget({ target: { providerId: 'acme-oidc', protocol: 'oidc' } }), { providerId: 'acme-oidc', protocol: 'oidc' })
  assert.deepEqual(parseLogoutTarget({ target: { providerId: 'acme-saml', protocol: 'saml', extra: 1 } }), { providerId: 'acme-saml', protocol: 'saml' })
  for (const value of [null, {}, { target: {} }, { target: { providerId: '', protocol: 'oidc' } }, { target: { providerId: 'x', protocol: 'ldap' } }, { target: 'oidc' }]) {
    assert.equal(parseLogoutTarget(value), undefined, JSON.stringify(value))
  }
})

test('the target is read with GET, no query, no-store, from the cookie session', async () => {
  const s = server({ 'GET /api/enterprise/logout-target': target(null) })
  assert.equal(await readLogoutTarget(s.fetch), null)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].init?.cache, 'no-store'); assert.equal(s.calls[0].init?.credentials, 'same-origin')
  await assert.rejects(readLogoutTarget(server({ 'GET /api/enterprise/logout-target': () => Response.json({ error: {} }, { status: 403 }) }).fetch), /logout_target_403/)
  await assert.rejects(readLogoutTarget(server({ 'GET /api/enterprise/logout-target': () => Response.json({ target: { protocol: 'oidc' } }) }).fetch))
})

test('OIDC posts JSON and navigates to the url the server returned', async () => {
  const s = server({ 'POST /api/auth/sso/oidc/logout/acme%20oidc': () => Response.json({ url: 'https://idp.example.test/logout?state=1', localSessionRevoked: true, upstream: 'requested' }) })
  const step = await enterpriseSignOutStep({ providerId: 'acme oidc', protocol: 'oidc' }, { origin, fetch: s.fetch })
  assert.deepEqual(step, { kind: 'navigate', url: 'https://idp.example.test/logout?state=1', upstream: 'requested' })
  assert.equal(s.calls[0].init?.method, 'POST'); assert.equal(s.calls[0].init?.body, '{}')
  assert.equal(new Headers(s.calls[0].init?.headers).get('content-type'), 'application/json')
})

test('OIDC refuses a failed POST, an unrevoked session or a non-http url', async () => {
  for (const body of [{ url: 'https://idp.example.test/', localSessionRevoked: false }, { url: 'javascript:alert(1)', localSessionRevoked: true }, { localSessionRevoked: true }]) {
    const s = server({ 'POST /api/auth/sso/oidc/logout/p': () => Response.json(body) })
    await assert.rejects(enterpriseSignOutStep({ providerId: 'p', protocol: 'oidc' }, { origin, fetch: s.fetch }), JSON.stringify(body))
  }
  const refused = server({ 'POST /api/auth/sso/oidc/logout/p': () => Response.json({ error: 'FORBIDDEN' }, { status: 403 }) })
  await assert.rejects(enterpriseSignOutStep({ providerId: 'p', protocol: 'oidc' }, { origin, fetch: refused.fetch }), /enterprise_sign_out_403/)
})

test('SAML is a top-level form POST the browser follows (its 302), never a fetch read as OIDC JSON', async () => {
  const s = server({})
  const step = await enterpriseSignOutStep({ providerId: 'acme-saml', protocol: 'saml' }, { origin, fetch: s.fetch })
  assert.deepEqual(step, { kind: 'form', action: '/api/auth/sso/saml2/logout/acme-saml', fields: { callbackURL: `${origin}/sign-in?login=1` } })
  assert.equal(s.calls.length, 0)
})

test('no target, a refused read or a runtime without a cookie session keep the existing sign-out', async () => {
  const run = async (cookieSession: boolean, answer: () => Response) => {
    const s = server({ 'GET /api/enterprise/logout-target': answer })
    const went: EnterpriseSignOutStep[] = []; let forgot = 0
    const routed = await routeEnterpriseSignOut({ cookieSession, origin, fetch: s.fetch, forget: async () => { forgot++ }, go: step => { went.push(step) } })
    return { routed, went, forgot, calls: s.calls.length }
  }
  assert.deepEqual(await run(true, target(null)), { routed: false, went: [], forgot: 0, calls: 1 })
  assert.deepEqual(await run(true, () => new Response(null, { status: 401 })), { routed: false, went: [], forgot: 0, calls: 1 })
  assert.deepEqual(await run(false, target({ providerId: 'p', protocol: 'saml' })), { routed: false, went: [], forgot: 0, calls: 0 }, 'desktop / a selected server read nothing')
})

test('an enterprise session clears local state once, then leaves through its protocol', async () => {
  const order: string[] = []
  const s = server({
    'GET /api/enterprise/logout-target': target({ providerId: 'p', protocol: 'oidc' }),
    'POST /api/auth/sso/oidc/logout/p': () => Response.json({ url: `${origin}/sign-in`, localSessionRevoked: true, upstream: 'not_supported' }),
  })
  const routed = await routeEnterpriseSignOut({ cookieSession: true, origin, fetch: s.fetch, forget: async () => { order.push('forget') }, go: step => { order.push(step.kind) } })
  assert.equal(routed, true)
  assert.deepEqual(order, ['forget', 'navigate'])
})

test('a SAML session keeps the existing sign-out until the form-logout fix is deployed (#1747)', async () => {
  const saml = server({ 'GET /api/enterprise/logout-target': target({ providerId: 'p', protocol: 'saml' }) })
  const steps: EnterpriseSignOutStep[] = []; let forgot = 0
  assert.equal(await routeEnterpriseSignOut({ cookieSession: true, origin, fetch: saml.fetch, forget: async () => { forgot++ }, go: step => { steps.push(step) } }), false)
  assert.deepEqual(steps, []); assert.equal(forgot, 0)
  assert.equal(saml.calls.length, 1, 'no SAML logout POST is sent as fetch + JSON')
})

test('the SAML step, once enabled, is a native form POST to the provider logout', async () => {
  assert.deepEqual(await enterpriseSignOutStep({ providerId: 'acme-saml', protocol: 'saml' }, { origin }), { kind: 'form', action: '/api/auth/sso/saml2/logout/acme-saml', fields: { callbackURL: `${origin}/sign-in?login=1` } })
})

test('the SAML form is a hidden top-level POST of urlencoded fields, submitted once', () => {
  const appended: unknown[] = []; let submitted = 0
  const elements: Record<string, unknown>[] = []
  const doc = {
    createElement: (tag: string) => { const element: Record<string, unknown> = { tag, children: [] as unknown[], append(child: unknown) { (this.children as unknown[]).push(child) }, submit() { submitted++ } }; elements.push(element); return element },
    body: { append: (node: unknown) => { appended.push(node) } },
  } as unknown as Document
  submitSignOutForm({ kind: 'form', action: '/api/auth/sso/saml2/logout/p', fields: { callbackURL: `${origin}/sign-in?login=1` } }, doc)
  const form = elements[0]
  assert.equal(form.tag, 'form'); assert.equal(form.method, 'POST'); assert.equal(form.action, '/api/auth/sso/saml2/logout/p'); assert.equal(form.hidden, true)
  assert.deepEqual((form.children as Record<string, unknown>[]).map(({ type, name, value }) => ({ type, name, value })), [{ type: 'hidden', name: 'callbackURL', value: `${origin}/sign-in?login=1` }])
  assert.deepEqual(appended, [form]); assert.equal(submitted, 1)
})
