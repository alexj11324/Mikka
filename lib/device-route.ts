import { authenticateDevice } from './device-link'
import { deviceRequestCaller } from './device-request-context'
import { withDeviceDatabaseAuthority, isDeviceAuthorityRevoked } from './db/device-scope'

/** Reuse each statement/transaction's write connection for the credential
 * lock. Long polls recheck whenever they query; no lock spans a wait or body.
 * Every handler's first database statement takes that lock before it acts, so
 * there is no separate check up front (it cost five statements per request).
 * So a handler must not call out, issue a credential (GitHub token, policy
 * snapshot, subscription lease) or write anything before its first database
 * statement; lib/device-route-fence.db.test.ts runs every route with a revoked
 * token to hold that. */
export function withDeviceRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    const caller = await authenticateDevice(request)
    if (!caller) return unauthorized()
    try {
      return await withDeviceDatabaseAuthority(caller, () => deviceRequestCaller.run(caller, () => handler(request, ...args)))
    } catch (error) {
      if (isDeviceAuthorityRevoked(error)) return unauthorized()
      throw error
    }
  }
}
