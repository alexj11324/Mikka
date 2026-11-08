import 'server-only'

/** Server authority is assigned by the operator, never inherited from a workspace role or signup order. */
export function isServerAdmin(userId: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(userId) && (env.MIKKA_SERVER_ADMIN_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean).includes(userId)
}

/** Configuration and credentials always require a current browser session. PAT workspace scopes are not server authority. */
export async function readServerSession(headers: Headers) {
  const { auth } = await import('@/lib/auth')
  return auth.api.getSession({ headers, query: { disableCookieCache: true } })
}
