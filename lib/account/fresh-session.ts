import 'server-only'
import { auth } from '@/lib/auth'

export class AccountAuthenticationError extends Error {
  constructor(readonly code: 'authRequired' | 'SESSION_NOT_FRESH', readonly status: 401 | 403) { super(code) }
}

/** Same createdAt/freshAge contract as Better Auth's freshSessionMiddleware, using its resolved server configuration. */
export async function requireFreshAccountSession(headers: Headers) {
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session?.user || !session.session) throw new AccountAuthenticationError('authRequired', 401)
  const { sessionConfig } = await auth.$context
  if (sessionConfig.freshAge !== 0) {
    const createdAt = new Date(session.session.createdAt).getTime()
    if (!Number.isFinite(createdAt) || Date.now() - createdAt >= sessionConfig.freshAge * 1000) throw new AccountAuthenticationError('SESSION_NOT_FRESH', 403)
  }
  return session
}
