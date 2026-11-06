import { decode, encode } from '../../../lib/desktop-rpc/wire'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const SMOKE_ID = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
export const OWNER_ID = 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'
export const fail = (code: string): never => { throw new Error(`issue1503_${code}`) }

/** A normal production login. Tokens, cookies and passwords stay in memory. */
export async function smokeSession() {
  const email = process.env.SMOKE_OWNER_EMAIL
  const password = process.env.SMOKE_OWNER_PASSWORD
  if (email !== 'alexjiang20232024+mikka-smoke-owner@gmail.com' || !password) fail('smoke_credentials_required')
  let cookie = '', token = ''
  async function request(path: string, init: RequestInit = {}) {
    if (!path.startsWith('/api/') || path.includes('://')) fail('request_path_invalid')
    return fetch(`${ORIGIN}/mikka${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } })
  }
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  async function json(path: string, init?: RequestInit) {
    const response = await request(path, init)
    if (!response.ok) fail(`http_${response.status}`)
    return response.json()
  }
  const response = await request('/api/auth/sign-in/email', post({ email, password }))
  if (!response.ok) fail(`login_${response.status}`)
  cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  const body = await response.json()
  token = body.token
  if (!cookie || typeof token !== 'string' || token.length < 32) fail('login_session_missing')
  const session = await json('/api/auth/get-session')
  if (session?.user?.id !== SMOKE_ID || session.user.email !== email) fail('login_identity_mismatch')
  async function rpc(action: string, args: unknown[]) {
    const response = await json('/api/desktop/rpc', post({ version: 1, action, args: encode(args) }))
    if (!response.ok) fail('rpc_failed')
    const result = decode(response.result) as any
    if (result?.ok === false) fail('rpc_action_failed')
    return result
  }
  return { request, json, post, rpc, user: session.user,
    async close() { try { await request('/api/auth/sign-out', post({})) } finally { cookie = ''; token = '' } } }
}
