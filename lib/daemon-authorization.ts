import { DAEMON_CLIENT_ID } from '@mikka/protocol/auth'

/** Relative to the origin, so Better Auth preserves a deployed app base path. */
export function daemonAuthorizationOptions(basePath: string) {
  return {
    validateClient: (clientId: string) => clientId === DAEMON_CLIENT_ID,
    verificationUri: `${basePath}/device`,
  }
}

type IssuedSession = { session: { token: string }; user: { id: string } }

/**
 * Better Auth's device grant issues a web session. Exchange it before the
 * response leaves the server: local daemon routes accept device_tokens only.
 * Revoke first, so neither a failed mint nor a successful response leaves an
 * extra web session behind. The browser's approving session is untouched.
 */
export async function exchangeDaemonSession(
  input: { path: string; clientId: unknown; returned: unknown; newSession: IssuedSession | null },
  dependencies: {
    issueToken: (userId: string) => Promise<string>
    revokeSession: (token: string) => Promise<void>
  },
): Promise<{ access_token: string; token_type: 'Bearer'; scope: 'device' } | null> {
  if (input.path !== '/device/token' || input.clientId !== DAEMON_CLIENT_ID || !input.newSession) return null
  const response = input.returned
  if (!response || typeof response !== 'object' || !('access_token' in response)
    || response.access_token !== input.newSession.session.token) return null
  await dependencies.revokeSession(input.newSession.session.token)
  const token = await dependencies.issueToken(input.newSession.user.id)
  return { access_token: token, token_type: 'Bearer', scope: 'device' }
}
