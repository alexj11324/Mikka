import { createHmac, timingSafeEqual } from 'node:crypto'
import type { EveAuthResult } from 'eve/channels/eve'
import { eveScopeSchema, scopeAuth, assertEveScope, type EveScope } from './scope'

function hostKey() {
  const key = process.env.BETTER_AUTH_SECRET
  if (!key || key.length < 32) throw new Error('authRequired')
  return key
}
/** Existing host key, domain-separated; never a user credential or model input. */
export function internalEveAuthorization(scope: EveScope, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...scope, expires: now + 60_000 })).toString('base64url')
  const signature = createHmac('sha256', hostKey()).update('mikka:eve:v1:' + payload).digest('base64url')
  return `Bearer mev_${payload}.${signature}`
}
export function internalEveScope(header: string | null, now = Date.now()): EveScope | null {
  if (!header?.startsWith('Bearer mev_')) return null
  const [payload, signature, extra] = header.slice(11).split('.')
  if (!payload || !signature || extra) return null
  const expected = createHmac('sha256', hostKey()).update('mikka:eve:v1:' + payload).digest()
  let actual: Buffer
  try { actual = Buffer.from(signature, 'base64url') } catch { return null }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!Number.isFinite(parsed.expires) || parsed.expires <= now || parsed.expires > now + 60_000) return null
    return eveScopeSchema.parse(parsed)
  } catch { return null }
}

/** Cloudflare carries the existing Eve principal through private service bindings.
 * The public ingress removes both headers; only a binding entrypoint can stamp
 * the trusted header. Other hosts retain their existing transport contract. */
export function internalEveHeaders(scope: EveScope): Record<string, string> {
  if (process.env.MIKKA_API_INGRESS === 'cloudflare' || process.env.MIKKA_EVE_HOST === 'cloudflare') {
    return { 'x-mikka-eve-scope': JSON.stringify(eveScopeSchema.parse(scope)) }
  }
  return { authorization: internalEveAuthorization(scope) }
}
export function internalEveRequestScope(request: Request): EveScope | null {
  if (process.env.MIKKA_API_INGRESS === 'cloudflare' || process.env.MIKKA_EVE_HOST === 'cloudflare') {
    try {
      const parsed = eveScopeSchema.safeParse(JSON.parse(request.headers.get('x-mikka-eve-binding-scope') ?? 'null'))
      return parsed.success ? parsed.data : null
    } catch { return null }
  }
  return internalEveScope(request.headers.get('authorization'))
}

export async function authenticateEveRequest(request: Request): Promise<EveAuthResult | null> {
  const internal = internalEveRequestScope(request)
  if (internal) return {...scopeAuth(await assertEveScope(internal)),allowAgentInfo:true}
  if (request.method !== 'GET' && request.method !== 'HEAD' && !request.headers.has('authorization')) {
    if (request.headers.get('sec-fetch-site') === 'cross-site') return null
    let origin:string, expected:string
    try {
      origin = new URL(request.headers.get('origin') ?? '').origin
      expected = new URL(process.env.BETTER_AUTH_URL ?? process.env.MIKKA_APP_ORIGIN ?? 'http://127.0.0.1:3000').origin
    } catch { return null }
    if (origin !== expected) return null
  }
  const { auth, apiWorkspaceAllowed } = await import('../api-auth')
  const credentials = new Headers(request.headers)
  // An explicit bearer is its own credential. Never let an invalid header
  // fall back to a cookie after bypassing the browser Origin gate.
  if (credentials.has('authorization')) credentials.delete('cookie')
  const session = await auth.api.getSession({ headers: credentials, query: { disableCookieCache: true } })
  if (!session) return null
  const bot=await (await import('./auth-bot')).resolveEveRequestBot(request,session)
  if (!bot || !apiWorkspaceAllowed(session, bot.workspaceId)) return null
  return scopeAuth(await assertEveScope({ ownerId: session.user.id, ...bot, surface: 'web' }))
}
