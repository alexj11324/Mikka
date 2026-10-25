/** Normalize only failed email-link navigation, after Better Auth's hooks run. */
export function verificationNavigationResponse(request: Request, response: Response, configuredOrigin: string) {
  const pathname = new URL(request.url).pathname
  if (request.method !== 'GET' || !['/api/auth/verify-email', '/mikka/api/auth/verify-email'].includes(pathname)) return response
  let failed = [400, 401, 403].includes(response.status)
  if ([302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (location) {
      try {
        const target = new URL(location, configuredOrigin)
        failed = target.origin === configuredOrigin && target.pathname === '/mikka/sign-in' &&
          ['INVALID_TOKEN', 'TOKEN_EXPIRED', 'USER_NOT_FOUND', 'INVALID_USER'].includes(target.searchParams.get('error') ?? '')
      } catch { /* Preserve an unrelated response. */ }
    }
  }
  // Rate limiting and server failures retain their real status and retry semantics.
  if (!failed) return response
  const origin = new URL(configuredOrigin)
  if (origin.origin !== configuredOrigin) throw new Error('Authentication origin must be canonical')
  return new Response(null, { status: 302, headers: {
    location: `${origin.origin}/mikka/verify-email?error=INVALID_TOKEN`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  } })
}
