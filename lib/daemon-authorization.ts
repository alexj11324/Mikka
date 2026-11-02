import { z } from 'zod'
import { DAEMON_CLIENT_ID } from '@mikka/protocol/auth'

/** What the machine asking to connect says about itself: shown on /device before 允许 (RFC 8628 §5.4). */
export type DeviceClientInfo = { device_name: string | null; device_platform: string | null; client_version: string | null }

// Shown as plain text: no control characters, bounded. The machine reports these itself, so they identify, not prove;
// the code the person checks against the terminal is what binds the approval to it.
const reported = (max: number) => z.string().max(max * 4).optional().transform(value => {
  const text = value?.replace(/[\p{C}]/gu, '').trim().slice(0, max)
  return text ? text : null
})

const daemonDeviceGrant = {
  requestSchemaFields: { device_name: reported(255), device_platform: reported(32), client_version: reported(64) },
  deviceCodeSchemaFields: {
    deviceName: { type: 'string', required: false },
    devicePlatform: { type: 'string', required: false },
    clientVersion: { type: 'string', required: false },
  },
  authorizeRequest: ({ request }: { request: { client_id?: string; device_name?: string | null; device_platform?: string | null; client_version?: string | null } }) =>
    request.client_id === DAEMON_CLIENT_ID
      ? { clientId: DAEMON_CLIENT_ID, deviceCodeFields: { deviceName: request.device_name ?? null, devicePlatform: request.device_platform ?? null, clientVersion: request.client_version ?? null } }
      : undefined,
  // Only daemon codes exist here, and they are redeemed by /device/token as before.
  assertSessionRedemption: () => {},
  // Better Auth adds this only for the signed-in person who claimed the code.
  getVerificationContext: (record: Record<string, unknown>): DeviceClientInfo => ({
    device_name: typeof record.deviceName === 'string' ? record.deviceName : null,
    device_platform: typeof record.devicePlatform === 'string' ? record.devicePlatform : null,
    client_version: typeof record.clientVersion === 'string' ? record.clientVersion : null,
  }),
} as const

/** Relative to the origin, so Better Auth preserves a deployed app base path. */
export function daemonAuthorizationOptions(basePath: string) {
  return {
    validateClient: (clientId: string) => clientId === DAEMON_CLIENT_ID,
    verificationUri: `${basePath}/device`,
    grant: daemonDeviceGrant,
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
