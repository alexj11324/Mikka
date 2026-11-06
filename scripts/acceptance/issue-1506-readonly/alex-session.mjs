// The ordinary production-session protocol, with a separate, exact Alex identity.
// ACME credentials are never assigned to the smoke account's environment names.
import { decode } from '../issue-1504-1506/production-session.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const BASE = ORIGIN + '/mikka'
const SHA = /^[0-9a-f]{40}$/
export const ALEX_OWNER_ID = 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'

export async function alexSession(work, { deadlineAt = null, expectedSha = process.env.MIKKA_ACCEPTANCE_SHA,
  env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const email = env.ACME_DEMO_EMAIL
  const password = env.ACME_DEMO_PASSWORD
  if (!/^[^@\s]+@[^@\s]+$/.test(email ?? '') || typeof password !== 'string' || !password) throw new Error('alex_credentials_missing')
  if (expectedSha != null && !SHA.test(expectedSha)) throw new Error('acceptance_sha_invalid')
  const cookies = new Map()
  const requests = []
  let signingOut = false
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', signal, headers: extra = {} } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('invalid_acceptance_path')
    const url = new URL(BASE + path)
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/mikka/')) throw new Error('invalid_acceptance_origin')
    const remaining = signingOut ? 15_000 : deadlineAt === null ? 180_000 : Math.min(180_000, deadlineAt - Date.now())
    if (remaining <= 0) throw new Error('acceptance_deadline_exceeded')
    const timeout = AbortSignal.timeout(Math.ceil(remaining))
    const started = performance.now()
    const response = await fetchImpl(url, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { origin: ORIGIN, 'cache-control': 'no-store',
        ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]
      const at = pair.indexOf('=')
      if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    requests.push({ path: url.pathname, method, status: response.status,
      headersMs: Math.round(performance.now() - started), requestId: response.headers.get('x-vercel-id') })
    return response
  }
  async function json(path, body, method) {
    const response = await request(path, { body, method })
    const value = await response.json().catch(() => null)
    if (!response.ok || value?.error) {
      const error = new Error('acceptance_http_failed')
      error.details = { path: path.split('?')[0], status: response.status }
      throw error
    }
    return value
  }
  async function rpc(action, args = []) {
    const response = await request('/api/rpc', { body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' } })
    const envelope = await response.json().catch(() => null)
    const value = decode(envelope?.result)
    if (!response.ok || envelope?.ok !== true || value?.error || value?.ok === false) {
      const error = new Error('acceptance_rpc_failed')
      error.details = { action, status: response.status }
      throw error
    }
    return value
  }
  try {
    await json('/api/auth/sign-in/email', { email, password })
    const identity = await json('/api/auth/get-session')
    if (identity?.user?.id !== ALEX_OWNER_ID || identity?.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('acceptance_identity_mismatch')
    const version = await json('/api/version')
    if (!SHA.test(version?.build ?? '')) throw new Error('acceptance_version_invalid')
    if (expectedSha && version.build !== expectedSha) throw new Error('acceptance_version_mismatch')
    return await work({ request, json, rpc, requests, identity: { userId: identity.user.id }, version })
  } finally {
    signingOut = true
    if (cookies.size) await json('/api/auth/sign-out', {}).catch(() => {})
    cookies.clear()
  }
}
